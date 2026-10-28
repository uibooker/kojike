package io.github.booker.kojike

import android.util.Log

/** 统一日志出口：宿主进程内接入 Xposed 日志，其他环境直接走 logcat。 */
object KojikeLog {
    const val TAG = "KojikeStats"

    @Volatile
    var sink: ((priority: Int, message: String, error: Throwable?) -> Unit)? = null

    fun info(message: String) = dispatch(Log.INFO, message, null)

    fun warn(message: String) = dispatch(Log.WARN, message, null)

    fun error(message: String, error: Throwable? = null) = dispatch(Log.ERROR, message, error)

    private fun dispatch(priority: Int, message: String, error: Throwable?) {
        try {
            val target = sink
            if (target != null) {
                target(priority, message, error)
            } else if (error == null) {
                Log.println(priority, TAG, message)
            } else {
                Log.println(priority, TAG, "$message: $error")
            }
        } catch (_: Throwable) {
            // 日志永不抛出
        }
    }
}
