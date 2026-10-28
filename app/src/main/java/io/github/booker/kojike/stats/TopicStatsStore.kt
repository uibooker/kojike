package io.github.booker.kojike.stats

import io.github.booker.kojike.KojikeLog
import io.github.booker.kojike.hooks.Reflect
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 「我」页面动态 → 圈子 统计存储。
 *
 * 数据来源是 Gson 解析 /personalUpdate/single 的结果：跨版本最稳的不是 hook 业务类，
 * 而是 hook Gson.fromJson 后按响应类型名过滤，再反射读 data 列表。
 * 统计按 username 分桶，只做会话内内存累计，进程死了就归零（够用，不落盘）。
 * 每个圈子额外保留动态明细（日期 + 内容）供面板二级列表展示。
 */
object TopicStatsStore {

    private const val MAX_USERS = 30
    private const val MAX_SEEN_POSTS = 20_000
    private const val MAX_TOPIC_POSTS = 200
    private const val MAX_CONTENT_LEN = 300

    /** 圈子下的一条动态明细。route 是宿主路由段（originalPost/repost），配合 id 可拼跳转 URL。 */
    class PostEntry(val id: String, val date: String, val content: String, val route: String)

    private class UserStat {
        val topicCounts = LinkedHashMap<String, Int>()
        val topicPosts = LinkedHashMap<String, MutableList<PostEntry>>()
        val seenPostIds = HashSet<String>()
        var totalPosts = 0
    }

    private val users = LinkedHashMap<String, UserStat>()

    /** 最近一次解析出的列表属主，UI 兜底用（fragment args 读不到时）。 */
    @Volatile
    var lastProfileUsername: String? = null
        private set

    fun setLastProfileUsername(username: String?) {
        if (!username.isNullOrEmpty()) lastProfileUsername = username
    }

    /** 无圈子的动态（纯文字/纯转发等）归入此虚拟圈子名下，与真实圈子同列。 */
    const val NO_TOPIC = "无圈子"

    /** 把一页动态计入 username 名下。posts 是反射来的 Message 对象，元素类型不感知。 */
    fun recordPosts(username: String, posts: List<*>) {
        if (username.isEmpty() || posts.isEmpty()) return
        synchronized(users) {
            val stat = touch(username)
            for (post in posts) {
                val postId = Reflect.readString(post, "id") ?: continue
                var topicName = extractTopicName(post)
                if (topicName == null && post?.javaClass?.name?.endsWith(".message.Repost") == true) {
                    // 转发到圈子的动态自身 topic 可能为空，从被转发的原动态兜底
                    topicName = extractTopicName(Reflect.read<Any>(post, "target"))
                }
                if (!stat.seenPostIds.add(postId)) continue // 分页重叠/刷新去重
                if (stat.seenPostIds.size > MAX_SEEN_POSTS) {
                    // 防膨胀：超限后停止收集明细 id（去重能力退化），计数照常累加，
                    // 绝不清桶——全量抓取重度用户时清零会把统计毁掉
                    stat.seenPostIds.remove(postId)
                }
                stat.totalPosts++
                val bucketName = topicName ?: NO_TOPIC
                stat.topicCounts[bucketName] = (stat.topicCounts[bucketName] ?: 0) + 1
                val bucket = stat.topicPosts.getOrPut(bucketName) { ArrayList() }
                if (bucket.size < MAX_TOPIC_POSTS) {
                    bucket.add(PostEntry(postId, extractDate(post), extractContent(post), extractRoute(post)))
                }
            }
            KojikeLog.info("recordPosts: user=$username, bucketTotal=${stat.totalPosts}, topics=${stat.topicCounts.size}")
        }
    }

    /** 快照：总动态数 + 圈子→次数（降序，最多 limit 行）。 */
    fun snapshot(username: String?, limit: Int = 30): Pair<Int, List<Pair<String, Int>>> {
        if (username.isNullOrEmpty()) return 0 to emptyList()
        synchronized(users) {
            val stat = users[username] ?: return 0 to emptyList()
            val topics = stat.topicCounts.entries
                .sortedByDescending { it.value }
                .take(limit)
                .map { it.key to it.value }
            return stat.totalPosts to topics
        }
    }

    /** 某个圈子下已加载的动态明细（按加载顺序，新的在后）。 */
    fun postsFor(username: String?, topic: String): List<PostEntry> {
        if (username.isNullOrEmpty() || topic.isEmpty()) return emptyList()
        synchronized(users) {
            return users[username]?.topicPosts?.get(topic).orEmpty().toList()
        }
    }

    /** 未截断的圈子总数：snapshot 列表有 30 行上限，头部计数要用这个。 */
    fun topicCount(username: String?): Int {
        if (username.isNullOrEmpty()) return 0
        synchronized(users) { return users[username]?.topicCounts?.size ?: 0 }
    }

    fun clear(username: String?) {
        if (username.isNullOrEmpty()) return
        synchronized(users) { users.remove(username) }
    }

    private fun touch(username: String): UserStat {
        users.remove(username)?.let { stat ->
            users[username] = stat // LinkedHashMap 重插到尾部实现 LRU
            return stat
        }
        while (users.size >= MAX_USERS) {
            val eldest = users.keys.first()
            users.remove(eldest)
            KojikeLog.warn("stat bucket evicted: $eldest")
        }
        return UserStat().also { users[username] = it }
    }

    /** Message.topic 是 protected 字段，Topic.content 是圈子显示名。 */
    private fun extractTopicName(message: Any?): String? {
        if (message == null) return null
        val topic = Reflect.read<Any>(message, "topic") ?: return null
        return Reflect.readString(topic, "content")?.takeIf { it.isNotBlank() }
    }

    /** 宿主详情路由段：originalPost / repost（路由表 mm/i.java 认这两个名字）。 */
    private fun extractRoute(message: Any?): String = when {
        message == null -> "originalPost"
        message.javaClass.name.endsWith(".message.Repost") -> "repost"
        else -> "originalPost"
    }

    /** createdAt 取 yyyy-MM-dd 前 10 位；极端情况是 epoch 毫秒。 */
    private fun extractDate(message: Any?): String {
        if (message == null) return ""
        return when (val raw = Reflect.read<Any>(message, "createdAt")) {
            is Number -> SimpleDateFormat("yyyy/MM/dd", Locale.US).format(Date(raw.toLong()))
            is String -> raw.take(10).replace('-', '/')
            else -> ""
        }
    }

    /** 转发动态自身 content 可能为空，用被转发原动态的内容兜底。 */
    private fun extractContent(message: Any?): String {
        if (message == null) return ""
        val own = Reflect.readString(message, "content")?.trim().orEmpty()
        if (own.isNotEmpty()) return own.take(MAX_CONTENT_LEN)
        val origin = Reflect.readString(Reflect.read<Any>(message, "target"), "content")?.trim().orEmpty()
        return if (origin.isEmpty()) "（无文字内容）" else "[转发] ${origin.take(MAX_CONTENT_LEN)}"
    }
}
