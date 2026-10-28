package io.github.booker.kojike.hooks

import java.lang.reflect.Field
import java.util.concurrent.ConcurrentHashMap

/** 反射小工具：沿类层级找字段并 setAccessible，结果缓存。 */
object Reflect {

    // ConcurrentHashMap 不接受 null value，用哨兵表示“查过但不存在”
    private val MISS = Any()

    private val cache = ConcurrentHashMap<String, Any>()

    /** 沿 clazz 向上（含 clazz 自身、直到 Object 之前）查找名为 name 的字段。找不到返回 null。 */
    fun findField(clazz: Class<*>, name: String): Field? {
        val key = clazz.name + "#" + name
        when (val cached = cache[key]) {
            MISS -> return null
            null -> {}
            else -> return cached as Field
        }
        var c: Class<*>? = clazz
        var found: Field? = null
        while (c != null && c != Any::class.java) {
            try {
                val f = c.getDeclaredField(name)
                f.isAccessible = true
                found = f
                break
            } catch (_: NoSuchFieldException) {
                c = c.superclass
            }
        }
        cache[key] = found ?: MISS
        return found
    }

    inline fun <reified T> read(obj: Any?, name: String): T? = try {
        if (obj == null) null else findField(obj.javaClass, name)?.get(obj) as? T
    } catch (error: Throwable) {
        if (error is VirtualMachineError || error is ThreadDeath) throw error
        null
    }

    fun readString(obj: Any?, name: String): String? = read(obj, name)
}
