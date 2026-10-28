package io.github.booker.kojike.ui

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import io.github.booker.kojike.KojikeLog
import io.github.booker.kojike.stats.FetchEngine
import io.github.booker.kojike.stats.TopicStatsStore

/**
 * 「圈子统计」页视图：挂在宿主 ph.c（ScanTextResultFragment，79 行的安静壳）实例上。
 *
 * 由 ProfileUiHook 拦截 po.c.F 为标记实例返回本视图；两级结构：
 * 圈子列表 → 圈子动态明细（点卡片跳宿主「即刻动态」详情页）。
 */
class KojikeStatsPage(private val context: Context) {

    private companion object {
        // 宿主色板：tint_jikeBlue=#03A9F4、tag 底 bg_on_body_2=#F0F3F5（反编译取值）
        val JIKE_BLUE: Int = 0xFF03A9F4.toInt()
        val TAG_BG_FALLBACK: Int = 0xFFF0F3F5.toInt()
    }

    private var body: FrameLayout? = null
    private var titleView: TextView? = null

    fun build(): View {
        val primary = themeColor(android.R.attr.textColorPrimary, Color.BLACK)
        val secondary = themeColor(android.R.attr.textColorSecondary, primary)
        val background = themeColor(android.R.attr.windowBackground, Color.WHITE)

        val root = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(background)
        }
        val header = FrameLayout(context)
        val title = TextView(context).apply {
            text = "统计"
            textSize = 16f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(primary)
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(10), dp(16), dp(10))
        }
        header.addView(
            title,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.START or Gravity.CENTER_VERTICAL
            )
        )
        val refresh = TextView(context).apply {
            text = "刷新"
            textSize = 13f
            setTextColor(secondary)
            setPadding(dp(20), dp(12), dp(20), dp(12))
        }
        header.addView(
            refresh,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.END or Gravity.CENTER_VERTICAL
            )
        )
        root.addView(header, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        val body = FrameLayout(context)
        root.addView(body, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        this.body = body
        this.titleView = title

        refresh.setOnClickListener { showTopics() }
        showTopics()
        return root
    }

    // ---------------------------------------------------------------- 一级：圈子列表

    private fun showTopics() {
        val body = body ?: return
        val primary = themeColor(android.R.attr.textColorPrimary, Color.BLACK)
        val secondary = themeColor(android.R.attr.textColorSecondary, primary)
        titleView?.text = "统计"
        titleView?.setOnClickListener(null)
        body.removeAllViews()

        val username = TopicStatsStore.lastProfileUsername
        val (total, topics) = TopicStatsStore.snapshot(username)
        val list = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        if (total == 0) {
            list.addView(
                TextView(context).apply {
                    text = "暂无数据：先到「动态」里上下滚动加载，再点「刷新」"
                    textSize = 14f
                    setTextColor(secondary)
                    gravity = Gravity.CENTER
                    setPadding(dp(16), dp(32), dp(16), dp(32))
                },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            )
        } else {
            list.addView(
                TextView(context).apply {
                    text = "共 $total 条动态 · ${TopicStatsStore.topicCount(username)} 个圈子（点击圈子看明细）"
                    textSize = 12f
                    setTextColor(secondary)
                    setPadding(dp(16), dp(8), dp(16), dp(8))
                },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            )
            topics.forEach { (name, count) ->
                val row = LinearLayout(context).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(12), dp(7), dp(16), dp(7))
                    isClickable = true
                    setRipple()
                }
                // 宿主 TopicTagLayout 同款胶囊：灰底圆角 10dp + 16dp 蓝色话题圆标 + 蓝字
                val tag = LinearLayout(context).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setBackgroundDrawable(
                        GradientDrawable().apply {
                            cornerRadius = dp(10).toFloat()
                            setColor(tagBgColor())
                        }
                    )
                    setPadding(dp(5), dp(5), dp(10), dp(5))
                }
                val icon = TextView(context).apply {
                    text = "#"
                    textSize = 11f
                    setTypeface(typeface, Typeface.BOLD)
                    setTextColor(Color.WHITE)
                    gravity = Gravity.CENTER
                    setBackgroundDrawable(
                        GradientDrawable().apply {
                            shape = GradientDrawable.OVAL
                            setColor(JIKE_BLUE)
                        }
                    )
                }
                tag.addView(icon, LinearLayout.LayoutParams(dp(16), dp(16)))
                val nameView = TextView(context).apply {
                    text = name
                    textSize = 14f
                    setTextColor(JIKE_BLUE)
                    maxLines = 1
                    ellipsize = TextUtils.TruncateAt.END
                }
                tag.addView(
                    nameView,
                    LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                        marginStart = dp(6)
                    }
                )
                row.addView(tag, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
                val countView = TextView(context).apply {
                    text = "$count 条 ›"
                    textSize = 13f
                    setTextColor(secondary)
                }
                row.addView(countView, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    gravity = Gravity.END or Gravity.CENTER_VERTICAL
                })
                row.setOnClickListener {
                    try {
                        showPosts(name)
                    } catch (error: Throwable) {
                        if (error is VirtualMachineError || error is ThreadDeath) throw error
                        KojikeLog.error("open topic posts failed", error)
                    }
                }
                list.addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            }
            list.addView(
                Button(context).apply {
                    text = "清空该用户统计"
                    setOnClickListener {
                        TopicStatsStore.clear(TopicStatsStore.lastProfileUsername)
                        showTopics()
                    }
                },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    setMargins(dp(16), dp(16), dp(16), dp(16))
                }
            )
        }
        // 全量统计：手动触发自动翻页（风险评审结论——不用冷启动自动抓）
        val fetchStatus = TextView(context).apply {
            textSize = 13f
            setTextColor(secondary)
            setPadding(dp(16), dp(4), dp(16), dp(4))
        }
        list.addView(
            Button(context).apply {
                text = "全量统计（抓取该用户全部动态）"
                setOnClickListener {
                    val username = TopicStatsStore.lastProfileUsername
                    if (username.isNullOrEmpty()) {
                        fetchStatus.text = "还没有已知的用户"
                        return@setOnClickListener
                    }
                    FetchEngine.start(context.classLoader)
                    pollProgress(fetchStatus, this)
                }
            },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                setMargins(dp(16), dp(8), dp(16), 0)
            }
        )
        list.addView(
            fetchStatus,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        )
        body.addView(
            ScrollView(context).apply {
                addView(list)
                // ScrollView 默认不参与嵌套滚动：个人页外层是 AppBar 联动布局，
                // 不开启的话上滚手势会被外层吞掉，列表回不到顶部
                isNestedScrollingEnabled = true
            },
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        )
    }

    /** 轮询抓取进度，主线程刷新状态行；结束后重载列表展示新数据。 */
    private fun pollProgress(statusView: TextView, button: Button) {
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        val tick = object : Runnable {
            override fun run() {
                val p = FetchEngine.progress
                statusView.text = when {
                    p.error != null -> p.error
                    p.running -> "抓取中：第 ${p.page} 页，已获取 ${p.fetched} 条…"
                    p.done -> "全量完成：共 ${p.page} 页 · ${p.fetched} 条"
                    else -> ""
                }
                button.isEnabled = !p.running
                button.alpha = if (p.running) 0.5f else 1f
                if (p.running) {
                    handler.postDelayed(this, 500)
                } else {
                    showTopics() // 结束（成功或失败）都重载列表展示新数据
                }
            }
        }
        tick.run()
    }

    // ---------------------------------------------------------------- 二级：圈子动态明细

    private fun showPosts(topic: String) {
        val body = body ?: return
        val primary = themeColor(android.R.attr.textColorPrimary, Color.BLACK)
        val secondary = themeColor(android.R.attr.textColorSecondary, primary)
        val background = themeColor(android.R.attr.windowBackground, Color.WHITE)
        titleView?.text = "‹ $topic"
        body.removeAllViews()

        val username = TopicStatsStore.lastProfileUsername
        val posts = TopicStatsStore.postsFor(username, topic).reversed() // 新的在前
        val list = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        if (posts.isEmpty()) {
            list.addView(
                TextView(context).apply {
                    text = "暂无动态明细"
                    textSize = 14f
                    setTextColor(secondary)
                    gravity = Gravity.CENTER
                    setPadding(dp(16), dp(32), dp(16), dp(32))
                },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            )
        }
        posts.forEach { post ->
            val card = LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(14), dp(10), dp(14), dp(10))
                setBackgroundDrawable(
                    GradientDrawable().apply {
                        cornerRadius = dp(10).toFloat()
                        setColor(shade(background, 0.94f))
                    }
                )
                isClickable = true
                setRipple()
                setOnClickListener {
                    try {
                        val url = "jike://page.jk/${post.route}/${post.id}"
                        KojikeLog.info("open post detail: $url")
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    } catch (error: Throwable) {
                        if (error is VirtualMachineError || error is ThreadDeath) throw error
                        KojikeLog.error("open post detail failed", error)
                    }
                }
            }
            card.addView(
                TextView(context).apply {
                    text = post.date
                    textSize = 12f
                    setTextColor(secondary)
                },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            )
            card.addView(
                TextView(context).apply {
                    text = post.content
                    textSize = 15f
                    setTextColor(primary)
                },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    topMargin = dp(4)
                }
            )
            // 宿主动态同款圈子 tag：胶囊 + 蓝 # 圆标 + 蓝字
            card.addView(
                LinearLayout(context).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setBackgroundDrawable(
                        GradientDrawable().apply {
                            cornerRadius = dp(10).toFloat()
                            setColor(tagBgColor())
                        }
                    )
                    setPadding(dp(5), dp(4), dp(10), dp(4))
                    addView(
                        TextView(context).apply {
                            text = "#"
                            textSize = 10f
                            setTypeface(typeface, Typeface.BOLD)
                            setTextColor(Color.WHITE)
                            gravity = Gravity.CENTER
                            setBackgroundDrawable(
                                GradientDrawable().apply {
                                    shape = GradientDrawable.OVAL
                                    setColor(JIKE_BLUE)
                                }
                            )
                        },
                        LinearLayout.LayoutParams(dp(14), dp(14))
                    )
                    addView(
                        TextView(context).apply {
                            text = topic
                            textSize = 12f
                            setTextColor(JIKE_BLUE)
                            maxLines = 1
                            ellipsize = TextUtils.TruncateAt.END
                        },
                        LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                            marginStart = dp(5)
                        }
                    )
                },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    topMargin = dp(8)
                }
            )
            list.addView(
                card,
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    setMargins(dp(12), dp(6), dp(12), dp(6))
                }
            )
        }
        body.addView(
            ScrollView(context).apply {
                addView(list)
                isNestedScrollingEnabled = true
            },
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        )
        // 标题即返回：点标题退回列表
        titleView?.setOnClickListener { showTopics() }
    }

    // ---------------------------------------------------------------- 工具

    /** tag 背景色：宿主 bg_on_body_2（浅 #F0F3F5 / 夜间 #262626）。 */
    private fun tagBgColor(): Int = themeColor(android.R.attr.colorBackground, TAG_BG_FALLBACK).let { fallback ->
        runCatching {
            // 夜间模式近似：亮度低时用深灰
            val lum = Color.luminance(fallback)
            if (lum < 0.3f) 0xFF262626.toInt() else TAG_BG_FALLBACK
        }.getOrDefault(TAG_BG_FALLBACK)
    }

    private fun View.setRipple() {
        val value = TypedValue()
        context.theme.resolveAttribute(android.R.attr.selectableItemBackground, value, true)
        foreground = context.getDrawable(value.resourceId)
    }

    private fun themeColor(attr: Int, fallback: Int): Int {
        val value = TypedValue()
        if (!context.theme.resolveAttribute(attr, value, true)) return fallback
        return if (value.type >= TypedValue.TYPE_FIRST_COLOR_INT && value.type <= TypedValue.TYPE_LAST_COLOR_INT) {
            value.data
        } else {
            runCatching { context.resources.getColor(value.resourceId, context.theme) }.getOrDefault(fallback)
        }
    }

    /** 浅色背景压暗、深色背景提亮，做卡片底色。 */
    private fun shade(color: Int, factor: Float): Int {
        val r = (color shr 16) and 0xFF
        val g = (color shr 8) and 0xFF
        val b = color and 0xFF
        val lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
        return if (lum > 0.5) {
            Color.rgb((r * factor).toInt(), (g * factor).toInt(), (b * factor).toInt())
        } else {
            Color.rgb(
                minOf(255, ((r + 40) * factor).toInt() + 30),
                minOf(255, ((g + 40) * factor).toInt() + 30),
                minOf(255, ((b + 40) * factor).toInt() + 30)
            )
        }
    }

    private fun dp(value: Int): Int =
        (value * context.resources.displayMetrics.density + 0.5f).toInt()
}
