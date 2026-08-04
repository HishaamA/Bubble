import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import './CardboardSetupFlow.css'

export type CardboardMemoryChoice = {
  id: string
  label: string
  sender: string
  thumbnailUrl: string
  crop?: {
    left: number
    top: number
    diameter: number
    sourceWidth: number
  }
}

type CardboardSetupStep = 'choose' | 'rotate' | 'cardboard'

export type CardboardSetupFlowProps = {
  open: boolean
  choices: readonly CardboardMemoryChoice[]
  selectedMemoryId: string
  busy?: boolean
  error?: string | null
  onSelectMemory: (memoryId: string) => void
  onGo: () => void
  onClose: () => void
}

function CardboardGlyph() {
  return (
    <svg viewBox="0 0 56 38" aria-hidden="true">
      <path d="M5 9h46v21.5a3.5 3.5 0 0 1-3.5 3.5h-9.2l-6-9h-8.6l-6 9H8.5A3.5 3.5 0 0 1 5 30.5z" />
      <circle cx="16" cy="20" r="5.5" />
      <circle cx="40" cy="20" r="5.5" />
      <path d="M21.5 20h13M14 9l2-5h24l2 5" />
    </svg>
  )
}

function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m7 7 10 10M17 7 7 17" />
    </svg>
  )
}

function ChoiceThumbnail({ choice }: { choice: CardboardMemoryChoice }) {
  const crop = choice.crop
  const imageStyle = crop
    ? ({
        width: `${(crop.sourceWidth / crop.diameter) * 100}%`,
        left: `${(-crop.left / crop.diameter) * 100}%`,
        top: `${(-crop.top / crop.diameter) * 100}%`,
      } satisfies CSSProperties)
    : undefined

  return (
    <span className="cardboard-setup__choice-image" aria-hidden="true">
      <img src={choice.thumbnailUrl} alt="" style={imageStyle} />
    </span>
  )
}

export function CardboardSetupFlow(props: CardboardSetupFlowProps) {
  if (!props.open) return null
  return <CardboardSetupContents {...props} />
}

function CardboardSetupContents({
  open,
  choices,
  selectedMemoryId,
  busy = false,
  error,
  onSelectMemory,
  onGo,
  onClose,
}: CardboardSetupFlowProps) {
  const [step, setStep] = useState<CardboardSetupStep>('choose')
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const continueButtonRef = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    if (!open) return
    closeButtonRef.current?.focus({ preventScroll: true })
  }, [open])

  useLayoutEffect(() => {
    if (!open || step === 'choose') return
    continueButtonRef.current?.focus({ preventScroll: true })
  }, [open, step])

  const selectedChoice =
    choices.find(({ id }) => id === selectedMemoryId) ?? choices[0]

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }

    if (event.key !== 'Tab') return
    const controls = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hasAttribute('aria-hidden'))
    const first = controls[0]
    const last = controls.at(-1)
    if (!first || !last) return

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <section
      className="cardboard-setup"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cardboard-setup-title"
      onKeyDown={handleDialogKeyDown}
    >
      <div className="cardboard-setup__ambient" aria-hidden="true" />

      <header className="cardboard-setup__header">
        <div>
          <p>Cardboard VR</p>
          <span>
            {step === 'choose' ? '1' : step === 'rotate' ? '2' : '3'} of 3
          </span>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          className="cardboard-setup__close"
          aria-label="Close VR setup"
          onClick={onClose}
        >
          <CloseGlyph />
        </button>
      </header>

      {step === 'choose' ? (
        <div className="cardboard-setup__step cardboard-setup__step--choose">
          <div className="cardboard-setup__copy">
            <p className="cardboard-setup__eyebrow">Available memories</p>
            <h2 id="cardboard-setup-title">Choose a moment</h2>
            <p>Pick the memory you want to step inside.</p>
          </div>

          <div
            className="cardboard-setup__choices"
            role="radiogroup"
            aria-label="Choose from available memories"
          >
            {choices.map((choice) => {
              const selected = choice.id === selectedMemoryId
              return (
                <button
                  key={choice.id}
                  type="button"
                  className="cardboard-setup__choice"
                  role="radio"
                  aria-checked={selected}
                  aria-label={`${choice.label}, ${choice.sender}`}
                  onClick={() => onSelectMemory(choice.id)}
                >
                  <ChoiceThumbnail choice={choice} />
                  <span className="cardboard-setup__choice-copy">
                    <strong>{choice.label}</strong>
                    <small>{choice.sender}</small>
                  </span>
                  <span className="cardboard-setup__choice-check" aria-hidden="true" />
                </button>
              )
            })}
          </div>

          <button
            ref={continueButtonRef}
            className="cardboard-setup__primary"
            type="button"
            disabled={!selectedChoice}
            onClick={() => setStep('rotate')}
          >
            Continue with {selectedChoice?.label ?? 'this memory'}
          </button>
        </div>
      ) : null}

      {step === 'rotate' ? (
        <div className="cardboard-setup__step cardboard-setup__step--rotate">
          <div className="cardboard-setup__rotation" aria-hidden="true">
            <span className="cardboard-setup__phone">
              <span />
            </span>
            <span className="cardboard-setup__rotation-arc" />
          </div>
          <div className="cardboard-setup__copy">
            <p className="cardboard-setup__eyebrow">{selectedChoice?.label}</p>
            <h2 id="cardboard-setup-title">Turn your phone sideways</h2>
            <p>
              Rotate from portrait to landscape so both Cardboard lenses line up
              with your memory.
            </p>
          </div>
          <button
            ref={continueButtonRef}
            className="cardboard-setup__primary"
            type="button"
            onClick={() => setStep('cardboard')}
          >
            Continue
          </button>
        </div>
      ) : null}

      {step === 'cardboard' ? (
        <div className="cardboard-setup__step cardboard-setup__step--cardboard">
          <div className="cardboard-setup__cardboard" aria-hidden="true">
            <CardboardGlyph />
            <span className="cardboard-setup__cardboard-glow" />
          </div>
          <div className="cardboard-setup__copy">
            <p className="cardboard-setup__eyebrow">{selectedChoice?.label}</p>
            <h2 id="cardboard-setup-title">Place your phone in Cardboard</h2>
            <p>
              Keep the screen facing the lenses. Once the phone is secure, press
              Go and put the viewer on.
            </p>
          </div>
          {error ? (
            <p className="cardboard-setup__error" role="alert">
              {error}
            </p>
          ) : null}
          <button
            ref={continueButtonRef}
            className="cardboard-setup__primary cardboard-setup__primary--go"
            type="button"
            disabled={busy || !selectedChoice}
            aria-busy={busy}
            onClick={onGo}
          >
            {busy ? 'Starting…' : 'Go'}
          </button>
          <button
            className="cardboard-setup__back"
            type="button"
            disabled={busy}
            onClick={() => setStep('choose')}
          >
            Choose another memory
          </button>
        </div>
      ) : null}
    </section>
  )
}
