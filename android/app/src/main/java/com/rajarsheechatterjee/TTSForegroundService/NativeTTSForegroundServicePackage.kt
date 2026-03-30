package com.rajarsheechatterjee.TTSForegroundService

import com.facebook.react.TurboReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class NativeTTSForegroundServicePackage : TurboReactPackage() {
    override fun getModule(name: String, context: ReactApplicationContext): NativeModule? {
        return if (name == "NativeTTSForegroundService") {
            NativeTTSForegroundServiceModule(context)
        } else {
            null
        }
    }

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
        return ReactModuleInfoProvider {
            mapOf(
                "NativeTTSForegroundService" to ReactModuleInfo(
                    "NativeTTSForegroundService",
                    "NativeTTSForegroundServiceModule",
                    false, // canOverrideExistingModule
                    false, // needsEagerInit
                    true,  // isCxxModule
                    true   // isTurboModule
                )
            )
        }
    }
}
