import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.simerfamily.kinsphere',
  appName: 'KinSphere',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_kinsphere',
      iconColor: '#DCAE7C',
      presentationOptions: ['badge', 'sound', 'banner', 'list'],
    },
  },
}

export default config
