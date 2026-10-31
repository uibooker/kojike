package io.github.booker.kojike.hooks

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import io.github.booker.kojike.KojikeLog
import io.github.booker.kojike.stats.TopicStatsStore
import io.github.booker.kojike.ui.KojikeStatsPage
import java.lang.ref.WeakReference
import io.github.libxposed.api.XposedInterface

/**
 * 把「圈子统计」插成个人页的真 tab 页（ViewPager 第 4 页 + 原生 tab）。
 *
 * 宿主结构（7.56.16 逆向：z1 / cp.e / no.c / ph.c）：
 * - z1（PersonalPagerPresenter）在 cp.e.B(TabLayout, RgViewPager, FM) 完成组装，
 *   cp.e.e(fragment, title, index) 是官方插页 API：adapter.addFragment(notify=true)
 *   + tabLayout.addTab(tab_with_badge 原生样式)，插完即与宿主页完全同权。
 * - 页面需是 po.c（RgFragment）实例，但模块 classloader 看不见宿主类、无法继承。
 *   借宿主最安静的 po.c 子类 ph.c（ScanTextResultFragment，79 行、无网络无观察者）
 *   当壳：newInstance 后 arguments 打标 kojike_page=true，再 hook
 *   po.c.F（视图模板方法，返回 KojikeStatsPage）与 ph.c.g0（初始化回调，置空）。
 *
 * B() 未命中（版本变动）时降级为悬浮 chip + 弹窗，保底可用。
 */
object ProfileUiHook {

    private const val FRAGMENT_CLASS = "com.ruguoapp.jike.bu.personal.ui.PersonalPagePostFragment"
    private const val PRESENTER_CLASS = "com.ruguoapp.jike.bu.personal.ui.z1"
    private const val BASE_PRESENTER_CLASS = "cp.e"
    private const val HOST_FRAGMENT_BASE = "po.c"
    private const val SHELL_FRAGMENT_CLASS = "ph.c"
    private const val TAB_TITLE = "统计"
    private const val MARK_ARG = "kojike_page"
    private const val CHIP_TAG = "kojike_stats_chip"

    @Volatile
    private var realTabInserted = false

    @Volatile
    private var statsPageRef: WeakReference<KojikeStatsPage>? = null

    /** 是否统计 tab 的标题（tv_tab_title 且文本为「统计」）。 */
    private fun isStatsTabTitle(view: TextView): Boolean =
        view.text == TAB_TITLE

    fun install(xposed: XposedInterface, loader: ClassLoader) {
        val basePresenter = try {
            loader.loadClass(BASE_PRESENTER_CLASS)
        } catch (error: Throwable) {
            if (error is VirtualMachineError || error is ThreadDeath) throw error
            KojikeLog.warn("cp.e not found, stats tab disabled")
            return
        }
        // B(TabLayout, RgViewPager, FragmentManager)：按 名字+参数个数 找，避免依赖混淆类型名
        val bindMethod = basePresenter.declaredMethods.firstOrNull {
            it.name == "B" && it.parameterCount == 3
        }
        if (bindMethod == null) {
            KojikeLog.warn("cp.e.B not found, stats tab disabled")
            return
        }
        xposed.hook(bindMethod)
            .setId("kojike_profile_page")
            .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
            .intercept { chain ->
                val result = chain.proceed()
                try {
                    insertPage(chain.thisObject, chain.args.getOrNull(0))
                } catch (error: Throwable) {
                    if (error is VirtualMachineError || error is ThreadDeath) throw error
                    KojikeLog.error("stats page insert failed", error)
                }
                result
            }

        // 壳 fragment 的视图与初始化换成模块实现（仅对打了标的实例生效）
        runCatching {
            val shellMethod = loader.loadClass(SHELL_FRAGMENT_CLASS)
                .getDeclaredMethod("g0", View::class.java)
            xposed.hook(shellMethod)
                .setId("kojike_shell_init")
                .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                .intercept { chain ->
                    val fragment = chain.thisObject
                    if (fragment != null && isMarkedStatsPage(fragment)) return@intercept null
                    chain.proceed()
                }
        }
        runCatching {
            val templateMethod = loader.loadClass(HOST_FRAGMENT_BASE).getDeclaredMethod(
                "F", LayoutInflater::class.java, ViewGroup::class.java
            )
            xposed.hook(templateMethod)
                .setId("kojike_shell_view")
                .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                .intercept { chain ->
                    val fragment = chain.thisObject
                    if (fragment != null && isMarkedStatsPage(fragment)) {
                        val inflater = chain.args.getOrNull(0) as? LayoutInflater
                            ?: return@intercept chain.proceed()
                        val page = KojikeStatsPage(inflater.context)
                        statsPageRef = WeakReference(page)
                        return@intercept page.build()
                    }
                    chain.proceed()
                }
        }

        // 统计 tab 被选中时重载页面内容：页面视图被 ViewPager 缓存，数据后到
        // （首屏竞态/清空后再积累）不会自动出现，造成「有数据但滑不动」的空态
        runCatching {
            val setSelected = loader.loadClass("android.widget.TextView")
                .getDeclaredMethod("setSelected", Boolean::class.javaPrimitiveType)
            xposed.hook(setSelected)
                .setId("kojike_stats_tab_selected")
                .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                .intercept { chain ->
                    val result = chain.proceed()
                    try {
                        val view = chain.thisObject as? TextView
                        val selected = chain.args.getOrNull(0) as? Boolean ?: false
                        if (view != null && selected && view.tag == null &&
                            view.id != View.NO_ID && isStatsTabTitle(view)
                        ) {
                            android.os.Handler(android.os.Looper.getMainLooper()).post {
                                runCatching { statsPageRef?.get()?.refreshTopLevel() }
                            }
                        }
                    } catch (error: Throwable) {
                        if (error is VirtualMachineError || error is ThreadDeath) throw error
                    }
                    result
                }
        }

        // 降级兜底：真 tab 未插入（版本变动）时挂悬浮 chip
        runCatching {
            val fragmentClass = loader.loadClass("androidx.fragment.app.Fragment")
            val onViewCreated = fragmentClass.getDeclaredMethod(
                "onViewCreated", View::class.java, Bundle::class.java
            )
            xposed.hook(onViewCreated)
                .setId("kojike_profile_fallback")
                .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                .intercept { chain ->
                    val result = chain.proceed()
                    try {
                        val fragment = chain.thisObject
                        if (fragment != null && fragment.javaClass.name == FRAGMENT_CLASS) {
                            ensureFallback(fragment, chain.args.getOrNull(0) as? View)
                        }
                    } catch (error: Throwable) {
                        if (error is VirtualMachineError || error is ThreadDeath) throw error
                    }
                    result
                }
        }
        KojikeLog.info("profile page hook installed")
    }

    /** B() 组装完成后插第 4 页；非个人页 presenter（cp.e 其他使用方）直接跳过。 */
    private fun insertPage(presenter: Any?, tabLayoutArg: Any?) {
        if (presenter == null) return
        val loader = presenter.javaClass.classLoader
        val presenterClass = runCatching { loader.loadClass(PRESENTER_CLASS) }.getOrNull() ?: return
        if (!presenterClass.isInstance(presenter)) return
        val tabLayout = tabLayoutArg as? View ?: return
        if (findTabTitle(tabLayout) != null) {
            realTabInserted = true
            return
        }
        val insertMethod = runCatching {
            loader.loadClass(BASE_PRESENTER_CLASS).getDeclaredMethod(
                "e",
                loader.loadClass(HOST_FRAGMENT_BASE),
                String::class.java,
                Int::class.javaPrimitiveType
            )
        }.getOrNull() ?: run {
            KojikeLog.warn("cp.e.e(fragment,title,index) not found")
            return
        }
        // 宿主壳实例：newInstance + arguments 打标
        val shell = runCatching {
            loader.loadClass(SHELL_FRAGMENT_CLASS).getDeclaredConstructor().newInstance()
        }.getOrNull() ?: run {
            KojikeLog.warn("shell fragment ph.c not instantiable")
            return
        }
        runCatching {
            shell.javaClass.getMethod("setArguments", Bundle::class.java)
                .invoke(shell, Bundle().apply { putBoolean(MARK_ARG, true) })
        }
        insertMethod.isAccessible = true
        insertMethod.invoke(presenter, shell, TAB_TITLE, 3)
        realTabInserted = true
        KojikeLog.info("stats page inserted as real tab")
    }

    /** 是否本模块打标的统计页壳实例。 */
    private fun isMarkedStatsPage(fragment: Any): Boolean = runCatching {
        val args = fragment.javaClass.getMethod("getArguments").invoke(fragment) as? Bundle
        args?.getBoolean(MARK_ARG, false) == true
    }.getOrDefault(false)

    /** tab 条里是否已有本模块的 tab 标题（tv_tab_title 文本匹配）。 */
    private fun findTabTitle(tabLayout: View): TextView? {
        var found: TextView? = null
        fun walk(view: View) {
            if (view is TextView && view.text == TAB_TITLE) found = view
            if (view is ViewGroup) for (i in 0 until view.childCount) walk(view.getChildAt(i))
        }
        walk(tabLayout)
        return found
    }

    // ---------------------------------------------------------------- 降级：悬浮 chip（真 tab 插入失败时兜底）

    private fun ensureFallback(fragment: Any, view: View?) {
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            try {
                if (realTabInserted) return@postDelayed
                KojikeLog.warn("real tab missing, fallback to chip")
                attachChip(fragment, view)
            } catch (error: Throwable) {
                if (error is VirtualMachineError || error is ThreadDeath) throw error
                KojikeLog.error("chip fallback failed", error)
            }
        }, 2500)
    }

    private fun attachChip(fragment: Any, view: View?) {
        val activity = resolveActivity(fragment, view) ?: return
        val decor = activity.window?.decorView as? ViewGroup ?: return
        val content = decor.findViewById<FrameLayout>(android.R.id.content) ?: return
        content.findViewWithTag<View>(CHIP_TAG)?.let { content.removeView(it) }
        val chip = buildChip(activity)
        content.addView(
            chip,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM or Gravity.END
            ).apply {
                rightMargin = dp(activity, 16)
                bottomMargin = dp(activity, 96)
            }
        )
        chip.setOnClickListener {
            try {
                showStatsDialog(activity, resolveUsername(fragment))
            } catch (error: Throwable) {
                if (error is VirtualMachineError || error is ThreadDeath) throw error
                KojikeLog.error("show stats dialog failed", error)
            }
        }
    }

    private fun buildChip(activity: Activity): TextView {
        val chip = TextView(activity)
        chip.id = View.generateViewId()
        chip.tag = CHIP_TAG
        chip.text = "📊 圈子统计"
        chip.setTextColor(Color.WHITE)
        chip.typeface = Typeface.DEFAULT_BOLD
        chip.textSize = 14f
        chip.setPadding(dp(activity, 12), dp(activity, 8), dp(activity, 12), dp(activity, 8))
        chip.background = GradientDrawable().apply {
            cornerRadius = dp(activity, 48).toFloat()
            setColor(0xAA000000.toInt())
        }
        chip.elevation = dp(activity, 6).toFloat()
        return chip
    }

    private fun showStatsDialog(activity: Activity, username: String?) {
        val (total, topics) = TopicStatsStore.snapshot(username)
        val message = buildString {
            if (total == 0) {
                append("暂无数据：请先浏览动态列表")
            } else {
                append("共 $total 条动态 · ${TopicStatsStore.topicCount(username)} 个圈子（本次会话已加载）\n\n")
                topics.forEach { (name, count) -> append("$name ×$count\n") }
            }
        }
        AlertDialog.Builder(activity)
            .setTitle("圈子动态统计")
            .setMessage(message)
            .setNeutralButton("清空该用户统计") { dialog, _ ->
                TopicStatsStore.clear(username)
                dialog.dismiss()
            }
            .setPositiveButton("关闭", null)
            .show()
    }

    // ---------------------------------------------------------------- 工具

    private fun resolveUsername(fragment: Any): String? {
        val args = runCatching {
            fragment.javaClass.getMethod("getArguments").invoke(fragment) as? Bundle
        }.getOrNull()
        val userIds = args?.get("userIds")
        val fromArgs = Reflect.readString(userIds, "b")
        return fromArgs?.takeIf { it.isNotEmpty() } ?: TopicStatsStore.lastProfileUsername
    }

    private fun resolveActivity(fragment: Any, view: View?): Activity? {
        val fromFragment = runCatching {
            fragment.javaClass.getMethod("getActivity").invoke(fragment) as? Activity
        }.getOrNull()
        return fromFragment ?: (view?.context as? Activity)
    }

    private fun dp(context: android.content.Context, value: Int): Int =
        (value * context.resources.displayMetrics.density + 0.5f).toInt()
}
