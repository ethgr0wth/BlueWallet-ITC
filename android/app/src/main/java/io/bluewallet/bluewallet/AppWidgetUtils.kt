package io.bluewallet.bluewallet

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.util.Log

object AppWidgetUtils {
    private const val TAG = "AppWidgetUtils"
    
    /**
     * Get all Interchained Price Widget IDs
     */
    fun getInterchainedPriceWidgetIds(context: Context): IntArray {
        val appWidgetManager = AppWidgetManager.getInstance(context)
        val component = ComponentName(context, InterchainedPriceWidget::class.java)
        return appWidgetManager.getAppWidgetIds(component)
    }
    
    /**
     * Trigger update for all widgets when theme changes
     */
    fun updateWidgetsForThemeChange(context: Context) {
        Log.d(TAG, "Updating widgets for theme change")
        
        // Update Interchained Price widgets - force a complete refresh
        val bitcoinWidgetIds = getInterchainedPriceWidgetIds(context)
        if (bitcoinWidgetIds.isNotEmpty()) {
            for (widgetId in bitcoinWidgetIds) {
                InterchainedPriceWidget.refreshWidget(context, widgetId)
            }
        }
        
        // Update Market widgets
        val marketWidgetIds = MarketWidget.getAllWidgetIds(context)
        if (marketWidgetIds.isNotEmpty()) {
            MarketWidget.refreshAllWidgetsImmediately(context)
        }
    }
}
