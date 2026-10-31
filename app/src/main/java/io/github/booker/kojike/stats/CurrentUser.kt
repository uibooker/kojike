package io.github.booker.kojike.stats

import io.github.booker.kojike.KojikeLog
import org.json.JSONObject

/**
 * 当前登录用户识别：读宿主账号文件 files/account_v2.json（AccountService 的本地持久层，
 * tj/a.java:34-35），顶层 JSON 有 username / isLoginUser 字段（LocalAccount.kt）。
 *
 * 模块与宿主同进程，host dataDir 直读即可；解析一次后缓存。识别失败返回 null，
 * 调用方 fail-closed（不统计），避免把别人的动态记进来。
 */
object CurrentUser {

    @Volatile
    private var cached: String? = null

    @Volatile
    private var resolved = false

    /** dataDir 来自 PackageLoadedParam.getApplicationInfo().dataDir。 */
    @Volatile
    var dataDir: String? = null

    fun username(): String? {
        if (resolved) return cached
        synchronized(this) {
            if (resolved) return cached
            cached = resolve()
            resolved = true
            if (cached != null) KojikeLog.info("current user resolved: $cached")
            else KojikeLog.warn("current user unknown (account file unreadable), stats gated")
        }
        return cached
    }

    private fun resolve(): String? {
        val dir = dataDir ?: return null
        return runCatching {
            val file = java.io.File(dir, "files/account_v2.json")
            if (!file.exists()) {
                KojikeLog.warn("account_v2.json not found at ${file.absolutePath}")
                return@runCatching null
            }
            val json = JSONObject(file.readText())
            val name = json.optString("username").takeIf { it.isNotEmpty() }
            val login = json.optBoolean("isLoginUser", false)
            if (!login && name != null) {
                // 匿名/未登录态：文件里仍可能有占位 username，此时不认
                KojikeLog.warn("account not logged in (isLoginUser=false)")
                return@runCatching null
            }
            name
        }.onFailure { error ->
            if (error is VirtualMachineError || error is ThreadDeath) throw error
            KojikeLog.warn("account_v2.json parse failed: ${error.message}")
        }.getOrNull()
    }
}
