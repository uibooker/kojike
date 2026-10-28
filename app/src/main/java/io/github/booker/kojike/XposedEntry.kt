package io.github.booker.kojike

import io.github.booker.kojike.hooks.GsonResponseHook
import io.github.booker.kojike.hooks.ProfileUiHook
import io.github.libxposed.api.XposedModule
import io.github.libxposed.api.XposedModuleInterface.ModuleLoadedParam
import io.github.libxposed.api.XposedModuleInterface.PackageLoadedParam
import java.util.concurrent.atomic.AtomicBoolean

class XposedEntry : XposedModule() {

    companion object {
        const val HOST_PACKAGE = "com.ruguoapp.jike"
    }

    private val installed = AtomicBoolean(false)

    // PackageLoadedParam 没有进程名（API 102 只有 packageName/applicationInfo 等），
    // 进程名只能在模块加载阶段记录
    private var processName: String? = null

    override fun onModuleLoaded(param: ModuleLoadedParam) {
        super.onModuleLoaded(param)
        processName = param.processName
        KojikeLog.sink = { priority, message, error ->
            if (error == null) log(priority, KojikeLog.TAG, message)
            else log(priority, KojikeLog.TAG, message, error)
        }
        KojikeLog.info("module loaded process=${param.processName}")
    }

    override fun onPackageLoaded(param: PackageLoadedParam) {
        super.onPackageLoaded(param)
        if (param.packageName != HOST_PACKAGE) return
        if (processName != HOST_PACKAGE) return // 仅主进程；推送等子进程跳过
        if (!installed.compareAndSet(false, true)) return
        try {
            // 宿主无壳，默认 classloader 直接可加载 gson / androidx / 业务模型，无需等待
            val loader = param.defaultClassLoader
            // 两组 hook 相互独立，一组失败不影响另一组
            try {
                GsonResponseHook.install(this, loader)
            } catch (error: Throwable) {
                if (error is VirtualMachineError || error is ThreadDeath) throw error
                KojikeLog.error("gson hook setup failed", error)
            }
            try {
                ProfileUiHook.install(this, loader)
            } catch (error: Throwable) {
                if (error is VirtualMachineError || error is ThreadDeath) throw error
                KojikeLog.error("profile ui hook setup failed", error)
            }
        } catch (error: Throwable) {
            if (error is VirtualMachineError || error is ThreadDeath) throw error
            KojikeLog.error("hook setup failed", error)
        }
    }
}
