import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.simerfamily.kinsphere',
  appName: 'KinSphere',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
}

export default config
