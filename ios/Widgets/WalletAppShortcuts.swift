//
//  WalletAppShortcuts.swift
//  BlueWallet


import AppIntents

@available(iOS 16.4, *)
struct WalletAppShortcuts: AppShortcutsProvider {
    
    @AppShortcutsBuilder
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: PriceIntent(),
            phrases: [
                AppShortcutPhrase<PriceIntent>("Market rate for Interchained in \(\.$fiatCurrency) using ${applicationName}"),
                AppShortcutPhrase<PriceIntent>("Get the current Interchained market rate in \(\.$fiatCurrency) with ${applicationName}"),
                AppShortcutPhrase<PriceIntent>("What's the current Interchained rate in \(\.$fiatCurrency) using ${applicationName}?"),
                AppShortcutPhrase<PriceIntent>("Show me the current Interchained price in \(\.$fiatCurrency) via ${applicationName}"),
                AppShortcutPhrase<PriceIntent>("Retrieve Interchained rate in \(\.$fiatCurrency) from ${applicationName}")
            ],
            shortTitle: "Market Rate",
            systemImageName: "bitcoinsign.circle"
        )
        
    }
}
