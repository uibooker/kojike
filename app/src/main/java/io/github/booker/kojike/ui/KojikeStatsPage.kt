package io.github.booker.kojike.ui

import android.app.Dialog
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
import android.widget.Space
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
        // 层级标记：挂在 body.tag 上供右上角动作判断
        const val LEVEL_TOPICS = "topics"
        const val LEVEL_POSTS = "posts"
    }

    private var body: FrameLayout? = null
    private var titleView: TextView? = null
    private var refreshView: TextView? = null

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
            setPadding(dp(24), dp(10), dp(8), dp(10))
        }
        header.addView(
            title,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.START or Gravity.CENTER_VERTICAL
            )
        )
        // header 右侧动作区：刷新（层级相关）+ 全量统计（仅一级有意义）
        val refresh = TextView(context).apply {
            text = "刷新"
            textSize = 13f
            setTextColor(secondary)
            setPadding(dp(16), dp(12), dp(24), dp(12))
        }
        header.addView(
            refresh,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.END or Gravity.CENTER_VERTICAL
            )
        )
        val fetchButton = TextView(context).apply {
            text = "全量统计"
            textSize = 13f
            setTextColor(JIKE_BLUE)
            setTypeface(typeface, Typeface.BOLD)
            setBackgroundDrawable(
                GradientDrawable().apply {
                    cornerRadius = dp(14).toFloat()
                    setColor(tagBgColor())
                }
            )
            setPadding(dp(12), dp(6), dp(12), dp(6))
        }
        header.addView(
            fetchButton,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.END or Gravity.CENTER_VERTICAL
            ).apply { marginEnd = dp(64) }
        )
        val fetchStatusInline = TextView(context).apply {
            textSize = 12f
            setTextColor(secondary)
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        }
        header.addView(
            fetchStatusInline,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.END or Gravity.CENTER_VERTICAL
            ).apply { marginEnd = dp(64) }
        )
        root.addView(header, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        val body = FrameLayout(context)
        root.addView(body, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        this.body = body
        this.titleView = title
        this.refreshView = refresh

        refresh.setOnClickListener { showTopics() } // 二级时 body.tag 已变，showTopics 会复位文案
        fetchButton.setOnClickListener { startFetch(fetchStatusInline, fetchButton) }
        showTopics()
        return root
    }

    // ---------------------------------------------------------------- 一级：圈子列表

    private fun showTopics() {
        val body = body ?: return
        val primary = themeColor(android.R.attr.textColorPrimary, Color.BLACK)
        val secondary = themeColor(android.R.attr.textColorSecondary, primary)
        body.tag = LEVEL_TOPICS
        titleView?.text = "统计"
        refreshView?.text = "刷新"
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
                    setPadding(dp(24), dp(32), dp(16), dp(32))
                },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            )
        } else {
            val summaryRow = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(24), dp(8), dp(16), dp(8))
            }
            summaryRow.addView(
                TextView(context).apply {
                    text = "共 $total 条动态 · ${TopicStatsStore.topicCount(username)} 个圈子（点击看明细）"
                    textSize = 12f
                    setTextColor(secondary)
                },
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            )
            // 行内「清空」文字按钮：点击弹确认窗
            summaryRow.addView(
                TextView(context).apply {
                    text = "清空"
                    textSize = 12f
                    setTextColor(0xFFE53935.toInt())
                    setPadding(dp(8), dp(4), dp(4), dp(4))
                    setOnClickListener { confirmClear() }
                }
            )
            list.addView(summaryRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            topics.forEach { (name, count) ->
                val row = LinearLayout(context).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(24), dp(7), dp(24), dp(7))
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
                    text = if (name == TopicStatsStore.NO_TOPIC) "◦" else "#"
                    textSize = 11f
                    setTypeface(typeface, Typeface.BOLD)
                    setTextColor(Color.WHITE)
                    gravity = Gravity.CENTER
                    setBackgroundDrawable(
                        GradientDrawable().apply {
                            shape = GradientDrawable.OVAL
                            setColor(if (name == TopicStatsStore.NO_TOPIC) tagIconColor() else JIKE_BLUE)
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
                // 计数徽章：tag 同色系小胶囊，数字突出、弱化文字，固定最右侧
                val spacer = Space(context)
                row.addView(spacer, LinearLayout.LayoutParams(0, 1, 1f))
                val countBadge = LinearLayout(context).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setBackgroundDrawable(
                        GradientDrawable().apply {
                            cornerRadius = dp(12).toFloat()
                            setColor(tagBgColor())
                        }
                    )
                    setPadding(dp(10), dp(3), dp(10), dp(3))
                    addView(
                        TextView(context).apply {
                            text = "$count"
                            textSize = 13f
                            setTypeface(typeface, Typeface.BOLD)
                            setTextColor(JIKE_BLUE)
                        }
                    )
                    addView(
                        TextView(context).apply {
                            text = "条 ›"
                            textSize = 11f
                            setTextColor(secondary)
                        },
                        LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                            marginStart = dp(2)
                        }
                    )
                }
                row.addView(countBadge, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
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
        }
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

    /** 清空确认弹窗（防误触）。自绘圆角卡片样式；dismiss 后把焦点还回列表，否则滑动失效。 */
    private fun confirmClear() {
        runCatching {
            val activity = context as? android.app.Activity ?: return
            val dialog = Dialog(activity)
            val box = LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundDrawable(
                    GradientDrawable().apply {
                        cornerRadius = dp(16).toFloat()
                        setColor(Color.WHITE)
                    }
                )
                setPadding(dp(24), dp(24), dp(24), dp(12))
            }
            box.addView(
                TextView(context).apply {
                    text = "清空统计"
                    textSize = 17f
                    setTypeface(typeface, Typeface.BOLD)
                    setTextColor(Color.BLACK)
                },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            )
            box.addView(
                TextView(context).apply {
                    text = "确定清空当前全部圈子统计吗？"
                    textSize = 14f
                    setTextColor(0xFF666666.toInt())
                    setPadding(0, dp(12), 0, 0)
                },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            )
            val actions = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.END
                setPadding(0, dp(24), 0, dp(8))
            }
            val cancel = TextView(context).apply {
                text = "取消"
                textSize = 14f
                setTextColor(0xFF888888.toInt())
                setPadding(dp(16), dp(8), dp(16), dp(8))
            }
            val confirm = TextView(context).apply {
                text = "清空"
                textSize = 14f
                setTypeface(typeface, Typeface.BOLD)
                setTextColor(Color.WHITE)
                setBackgroundDrawable(
                    GradientDrawable().apply {
                        cornerRadius = dp(18).toFloat()
                        setColor(0xFFE53935.toInt())
                    }
                )
                setPadding(dp(20), dp(8), dp(20), dp(8))
                (layoutParams as? LinearLayout.LayoutParams)?.marginStart = dp(12)
            }
            actions.addView(cancel)
            actions.addView(
                confirm,
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    marginStart = dp(12)
                }
            )
            box.addView(actions, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            dialog.setContentView(box)
            dialog.window?.setBackgroundDrawableResource(android.R.color.transparent)
            dialog.setOnDismissListener {
                // 系统对话框收起时会带走触摸焦点，不还回来列表就滑不动
                val scroll = body?.getChildAt(0)
                scroll?.isFocusable = true
                scroll?.isFocusableInTouchMode = true
                scroll?.requestFocus()
            }
            cancel.setOnClickListener { dialog.dismiss() }
            confirm.setOnClickListener {
                TopicStatsStore.clear(TopicStatsStore.lastProfileUsername)
                dialog.dismiss()
                showTopics()
            }
            dialog.show()
        }.onFailure { error ->
            if (error is VirtualMachineError || error is ThreadDeath) throw error
            KojikeLog.error("confirm clear failed", error)
        }
    }

    /** 全量统计触发 + header 行内进度展示。 */
    private fun startFetch(statusView: TextView, button: TextView) {
        val username = TopicStatsStore.lastProfileUsername
        if (username.isNullOrEmpty()) {
            statusView.text = "无用户"
            return
        }
        FetchEngine.start(context.classLoader)
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        val tick = object : Runnable {
            override fun run() {
                val p = FetchEngine.progress
                statusView.text = when {
                    p.error != null -> p.error
                    p.running -> "${p.fetched} 条…"
                    p.done -> "✓${p.fetched}条"
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
        // 右上角动作随层级切换：二级时是「返回」
        body.tag = LEVEL_POSTS
        refreshView?.text = "返回"
        titleView?.text = topic
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
                    setPadding(dp(24), dp(32), dp(16), dp(32))
                },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            )
        }
        posts.forEach { post ->
            val card = LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(14), dp(10), dp(14), dp(12))
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
            list.addView(
                card,
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    setMargins(dp(16), dp(6), dp(16), dp(6))
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
    }

    // ---------------------------------------------------------------- 工具

    /** 「无圈子」圆标色：即刻蓝降饱和的灰蓝，与真实话题区分。 */
    private fun tagIconColor(): Int {
        val base = JIKE_BLUE
        val gray = (Color.red(base) + Color.green(base) + Color.blue(base)) / 3
        return Color.argb(
            255,
            (Color.red(base) + gray) / 2,
            (Color.green(base) + gray) / 2,
            (Color.blue(base) + gray) / 2
        )
    }

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
