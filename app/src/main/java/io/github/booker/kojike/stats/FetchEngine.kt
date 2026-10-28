package io.github.booker.kojike.stats

import android.os.Handler
import android.os.Looper
import io.github.booker.kojike.KojikeLog
import io.github.booker.kojike.hooks.Reflect

/**
 * 全量统计引擎：复用宿主网络栈反射翻页 `/personalUpdate/single`，把每页喂给
 * TopicStatsStore（与现有 GsonResponseHook 管道共用 seenPostIds 去重，双重喂入幂等）。
 *
 * 反射路径（7.56.16 逆向，全部 public/静态成员，零 hook）：
 * - `ku.b.f36739a` 静态单例（ku/b.java:27），`n(url, Class)` 造 POST builder（ku/b.java:107）
 * - `D(key, value)` 附加参数、`m()` 同步执行返回 `uu.a`（tu/h.java:445）
 * - token/签名/重试全部由宿主栈自理（TokenInterceptor、401 刷新重放），模块不碰
 * - 终止：`ServerResponse.loadMoreKey == null`（ListResponse.java:14）或空页/重复游标/页数上限
 *
 * 手动触发（统计页「全量统计」按钮），daemon 线程跑同步请求，400~800ms 随机限速，
 * 429/403 立即中止、连续失败 3 次中止（保留已抓数据）。fail-closed：一切异常只进状态对象。
 */
object FetchEngine {

    /** 进度快照，UI 轮询展示。 */
    data class Progress(
        val running: Boolean = false,
        val page: Int = 0,
        val fetched: Int = 0,
        val done: Boolean = false,
        val error: String? = null,
    )

    private const val PATH = "/personalUpdate/single"
    private const val RESPONSE_CLASS = "com.ruguoapp.jike.library.data.server.response.TypeNeoListResponse"
    private const val PAGE_LIMIT = 600 // 约 1.5 万条，超限视为异常停
    private const val MAX_FAIL_STREAK = 3

    private val main = Handler(Looper.getMainLooper())
    private val running = java.util.concurrent.atomic.AtomicBoolean(false)

    @Volatile
    var progress: Progress = Progress()
        private set

    fun start(loader: ClassLoader) {
        if (!running.compareAndSet(false, true)) {
            KojikeLog.warn("fetch already running")
            return
        }
        progress = Progress(running = true)
        val username = TopicStatsStore.lastProfileUsername
        if (username.isNullOrEmpty()) {
            progress = Progress(error = "还没有已知的用户，先到「动态」滚动一下")
            running.set(false)
            return
        }
        Thread {
            try {
                fetchAll(loader, username)
            } catch (error: Throwable) {
                if (error is VirtualMachineError || error is ThreadDeath) throw error
                KojikeLog.error("fetch failed", error)
                progress = progress.copy(running = false, done = true, error = "抓取中断：${error.message}")
            } finally {
                running.set(false)
            }
        }.apply {
            isDaemon = true
            name = "kojike-fetch"
            start()
        }
    }

    private fun fetchAll(loader: ClassLoader, username: String) {
        val kuBClazz = loader.loadClass("ku.b")
        // 静态单例字段名是混淆产物（jadx 显示的 f36739a 非真名），按「static 且类型=ku.b」定位
        val singletonField = kuBClazz.declaredFields.firstOrNull {
            java.lang.reflect.Modifier.isStatic(it.modifiers) && it.type == kuBClazz
        } ?: throw IllegalStateException("ku.b singleton not found")
        singletonField.isAccessible = true
        val kuB = singletonField.get(null)
        val nMethod = kuB.javaClass.getMethod(
            "n", String::class.java, Class::class.java
        )
        val responseClass = loader.loadClass(RESPONSE_CLASS)
        val dMethod = nMethod.returnType.getMethod("D", String::class.java, Any::class.java)
        val mMethod = nMethod.returnType.getMethod("m")

        var key: Any? = null
        val seenKeys = HashSet<Any>()
        var page = 0
        var failStreak = 0
        var backoffMs = 1000L

        while (page < PAGE_LIMIT) {
            if (progress.error != null) return
            val builder = nMethod.invoke(kuB, PATH, responseClass)
            dMethod.invoke(builder, "username", username)
            dMethod.invoke(builder, "limit", 25L)
            dMethod.invoke(builder, "loadMoreKey", key)
            val result = mMethod.invoke(builder)

            // uu.a 无 success 字段：g()=数据非空（成功），c()=解析好的响应对象，
            // f()=异常，b()=HTTP code（uu/a.java:73-106）
            val gMethod = result.javaClass.getMethod("g")
            val cMethod = result.javaClass.getMethod("c")
            val bMethod = result.javaClass.getMethod("b")
            val fMethod = result.javaClass.getMethod("f")
            val ok = gMethod.invoke(result) as? Boolean == true
            val payload = if (ok) cMethod.invoke(result) else null
            val data = payload?.let { Reflect.read<List<*>>(it, "data") }
            if (!ok || payload == null || data == null) {
                val http = bMethod.invoke(result)
                val throwable = fMethod.invoke(result) as? Throwable
                val code = payload?.let { Reflect.readString(it, "code") }
                    ?: throwable?.message ?: "http=$http"
                KojikeLog.warn("fetch page $page not ok: $code, failStreak=$failStreak")
                failStreak++
                if (isRiskControl(code) || failStreak >= MAX_FAIL_STREAK) {
                    progress = progress.copy(
                        running = false, done = true,
                        error = "服务端拒绝/连续失败（$code），已保留已抓数据"
                    )
                    return
                }
                Thread.sleep(backoffMs)
                backoffMs *= 2
                continue
            }
            failStreak = 0
            backoffMs = 1000L
            page++
            val fetchedBefore = progress.fetched
            // 与 GsonResponseHook 管道共用 seenPostIds 去重，重复喂入幂等
            TopicStatsStore.recordPosts(username, data)
            val newKey = Reflect.read<Any>(payload, "loadMoreKey")
            KojikeLog.info("fetch page=$page, key=$newKey, firstId=${Reflect.readString(data.firstOrNull(), "id")}")
            progress = progress.copy(page = page, fetched = fetchedBefore + data.size)
            if (newKey == null || data.isEmpty() || !seenKeys.add(newKey)) break
            key = newKey
            Thread.sleep(400L + (0..400).random())
        }
        progress = progress.copy(running = false, done = true)
        KojikeLog.info("fetch done: user=$username, pages=$page")
    }

    /** 业务级风控信号：HTTP 层的 429/403 在 code 字段或 success=false 上体现。 */
    private fun isRiskControl(code: String?): Boolean {
        code ?: return false
        return code.contains("429") || code.contains("403") || code == "E101"
    }

    /** UI 轮询用：主线程回调当前进度。 */
    fun observe(callback: (Progress) -> Unit) {
        main.post { callback(progress) }
    }
}
