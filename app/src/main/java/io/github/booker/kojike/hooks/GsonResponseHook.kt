package io.github.booker.kojike.hooks

import io.github.booker.kojike.KojikeLog
import io.github.booker.kojike.stats.TopicStatsStore
import io.github.booker.kojike.ui.KojikeStatsPage
import io.github.libxposed.api.XposedInterface
import java.io.Reader

/**
 * 拦截宿主统一响应解析点 Gson.fromJson(Reader, Class)。
 *
 * 宿主网络栈（io.iftech.android.network）整体混淆，但 Gson 与响应模型（@Keep）未混淆，
 * 所有 POST 响应都从 Gson.fromJson(Reader, Class) 出来——在此按响应类型过滤出
 * TypeNeoListResponse（/personalUpdate/single「我」页面动态列表）即可，不碰业务类。
 */
object GsonResponseHook {

    private const val RESPONSE_CLASS = "com.ruguoapp.jike.library.data.server.response.TypeNeoListResponse"

    fun install(xposed: XposedInterface, loader: ClassLoader) {
        // fail-closed：定位不到解析点就放弃本组 hook，绝不影响宿主与其他 hook
        val method = try {
            loader.loadClass("com.google.gson.Gson").getDeclaredMethod(
                "fromJson",
                Reader::class.java,
                Class::class.java
            )
        } catch (error: Throwable) {
            if (error is VirtualMachineError || error is ThreadDeath) throw error
            KojikeLog.warn("gson fromJson(Reader,Class) not found, stats disabled")
            return
        }
        xposed.hook(method)
            .setId("kojike_gson_fromjson")
            .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
            .intercept { chain ->
                val result = chain.proceed()
                try {
                    val clazz = chain.args.getOrNull(1) as? Class<*> ?: return@intercept result
                    if (clazz.name == RESPONSE_CLASS && result != null) {
                        onResponse(result)
                    }
                } catch (error: Throwable) {
                    if (error is VirtualMachineError || error is ThreadDeath) throw error
                    KojikeLog.error("gson hook stats failed", error)
                }
                result
            }
        KojikeLog.info("gson response hook installed")
    }

    /** result: TypeNeoListResponse，data: List<TypeNeo>，元素以 Message 为主（可能夹杂 null）。 */
    private fun onResponse(result: Any) {
        val data = Reflect.read<List<*>>(result, "data") ?: return
        if (data.isEmpty()) return
        // TypeNeoListResponse 被发现页/话题页等 feed 共用；个人页接口（/personalUpdate/single）
        // 的每条动态属主都是同一人，多作者的一律跳过，避免 feed 内容混进统计
        val usernames = data.asSequence()
            .filterNotNull()
            .mapNotNull { Reflect.read<Any>(it, "user") }
            .mapNotNull { Reflect.readString(it, "username") }
            .distinct()
            .toList()
        if (usernames.size != 1) return
        val username = usernames.first()
        TopicStatsStore.setLastProfileUsername(username)
        TopicStatsStore.recordPosts(username, data)
        // 统计 tab 正在前台时让页面实时刷新（主线程）
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            runCatching { KojikeStatsPage.active?.notifyDataChanged() }
        }
        KojikeLog.info("personalUpdate/single parsed: user=$username, items=${data.size}")
    }
}
