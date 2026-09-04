/** Shared Clerk modal tokens that keep hosted authentication inside Bubble's visual system. */
export const clerkAppearance = {
  variables: {
    colorPrimary: '#e3a638',
    colorBackground: '#fbf2d9',
    colorInputBackground: '#fffaf0',
    colorInputText: '#173b63',
    colorText: '#173b63',
    colorTextSecondary: '#66778a',
    borderRadius: '0.65rem',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", sans-serif',
  },
  options: {
    animations: true,
    // Local/demo builds intentionally use Clerk development instances; Bubble
    // provides its own setup state instead of showing Clerk's duplicate banner.
    unsafe_disableDevelopmentModeWarnings: true,
  },
  elements: {
    modalBackdrop: {
      alignItems: 'center',
      backgroundColor: 'rgba(23, 59, 99, 0.68)',
      backdropFilter: 'blur(7px)',
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
      boxShadow:
        '0.38rem 0.44rem 0 #efb944, 0 1.4rem 4rem rgba(23, 59, 99, 0.32)',
    },
    card: {
      border: '2px solid #173b63',
      boxShadow: 'none',
      padding: '1.75rem 1.5rem',
    },
    header: {
      gap: 0,
    },
    headerTitle: {
      color: '#173b63',
      fontFamily: 'ui-serif, "Iowan Old Style", Baskerville, Georgia, serif',
      fontSize: '1.75rem',
      fontWeight: 650,
      letterSpacing: '-0.035em',
      lineHeight: 1.08,
    },
    main: {
      gap: '1.25rem',
    },
    socialButtonsBlockButton: {
      border: '2px solid rgba(23, 59, 99, 0.66)',
      borderRadius: '0.55rem',
      boxShadow: '0.16rem 0.18rem 0 rgba(120, 184, 208, 0.52)',
    },
    formFieldInput: {
      borderColor: 'rgba(23, 59, 99, 0.32)',
      borderRadius: '0.5rem',
    },
    phoneInputBox: {
      minWidth: 0,
      width: '100%',
    },
    formFieldInput__phoneNumber: {
      minWidth: 0,
    },
    formButtonPrimary: {
      border: '2px solid #173b63',
      borderRadius: '0.58rem 0.76rem 0.6rem 0.7rem',
      color: '#173b63',
      boxShadow: '0.2rem 0.22rem 0 #173b63',
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

/** Product-specific copy overrides for Clerk's sign-in and sign-up screens. */
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
