package org.interchained.elara.components.segmentedcontrol

import org.interchained.elara.ReactPackage
import com.facebook.react.bridge.NativeModule
import org.interchained.elara.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class CustomSegmentedControlPackage : ReactPackage {

    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return emptyList()
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return listOf(CustomSegmentedControlManager())
    }
}
