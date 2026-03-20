package com.rajarsheechatterjee.NativeExpoSpeech

import com.facebook.react.TurboReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class NativeExpoSpeechPackage : TurboReactPackage() {
    override fun getModule(name: String, context: ReactApplicationContext): NativeModule? {
        return if (name == "NativeExpoSpeech") {
            NativeExpoSpeechModule(context)
        } else {
            null
        }
    }

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
        return ReactModuleInfoProvider {
            mapOf(
                "NativeExpoSpeech" to ReactModuleInfo(
                    "NativeExpoSpeech",
                    "NativeExpoSpeechModule",
                    false, // canOverrideExistingModule
                    false, // needsEagerInit
                    true,  // isCxxModule
                    true   // isTurboModule
                )
            )
        }
    }
}
