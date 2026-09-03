import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  // The native identifier remains stable across the product's Bubble rename so
  // existing keychain data, notifications, and installed upgrades keep working.
  appId: 'com.simerfamily.kinsphere',
  appName: 'Bubble',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_kinsphere',
      iconColor: '#DCAE7C',
      presentationOptions: ['badge', 'sound', 'banner', 'list'],
    },
  },
}

export default config
