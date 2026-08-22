export const clerkAppearance = {
  variables: {
    colorPrimary: '#e6b476',
    colorBackground: '#0a0a0a',
    colorInputBackground: '#080808',
    colorInputText: '#f5f5f7',
    colorText: '#f5f5f7',
    colorTextSecondary: 'rgba(235, 235, 245, 0.58)',
    borderRadius: '1rem',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", sans-serif',
  },
  options: {
    animations: true,
    unsafe_disableDevelopmentModeWarnings: true,
  },
  elements: {
    modalBackdrop: {
      alignItems: 'center',
      backgroundColor: 'rgba(0, 0, 0, 0.82)',
      backdropFilter: 'blur(8px)',
      boxSizing: 'border-box',
      justifyContent: 'center',
      minHeight: '100dvh',
      overflowY: 'auto',
      padding:
        'max(1rem, env(safe-area-inset-top, 0px)) 1rem max(1rem, env(safe-area-inset-bottom, 0px))',
    },
    modalContent: {
      margin: 'auto',
      maxHeight:
        'calc(100dvh - max(2rem, env(safe-area-inset-top, 0px)) - max(2rem, env(safe-area-inset-bottom, 0px)))',
      width: 'min(100%, 24rem)',
    },
    cardBox: {
      maxHeight: 'inherit',
      overflowY: 'auto',
      overscrollBehavior: 'contain',
      boxShadow: '0 1.4rem 4rem rgba(0, 0, 0, 0.7)',
    },
    card: {
      border: '1px solid rgba(230, 180, 118, 0.24)',
      boxShadow: 'none',
      padding: '1.75rem 1.5rem',
    },
    header: {
      gap: 0,
    },
    headerTitle: {
      fontSize: '1.45rem',
      lineHeight: 1.2,
    },
    main: {
      gap: '1.25rem',
    },
    socialButtonsBlockButton: {
      borderColor: 'rgba(230, 180, 118, 0.28)',
    },
    formFieldInput: {
      borderColor: 'rgba(255, 255, 255, 0.16)',
    },
    phoneInputBox: {
      minWidth: 0,
      width: '100%',
    },
    formFieldInput__phoneNumber: {
      minWidth: 0,
    },
    formButtonPrimary: {
      color: '#181009',
      boxShadow: 'none',
      fontWeight: 700,
    },
    footerAction: {
      paddingBlock: '0.85rem',
    },
    footerItem: {
      paddingBlock: '0.9rem',
    },
  },
} as const

export const clerkLocalization = {
  formFieldInputPlaceholder__phoneNumber: 'Phone number',
  signIn: {
    start: {
      subtitle: '',
      subtitleCombined: '',
    },
  },
  signUp: {
    start: {
      subtitle: '',
      subtitleCombined: '',
    },
  },
} as const
