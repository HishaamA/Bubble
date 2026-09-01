import './AppWhimsy.css'

export type AppWhimsyPage = 'moments' | 'capsule' | 'journal' | 'settings'

type AppWhimsyProps = {
  page: AppWhimsyPage
}

export function AppWhimsy({ page }: AppWhimsyProps) {
  return (
    <div
      className={`app-whimsy app-whimsy--${page}`}
      data-app-whimsy
      data-whimsy-page={page}
      aria-hidden="true"
    >
      <svg
        className="app-whimsy__cloud app-whimsy__cloud--large"
        viewBox="0 0 94 45"
        focusable="false"
      >
        <path d="M8 35.5c.8-7.8 7.1-13.2 14.7-13.2 3.5-10.8 18.7-14.2 27-5.8 4.2-3 9-4.2 13.7-2.8 7.3 2 11.5 8 11.7 14.7 7.1.2 11.1 3 11.9 7.1H8Z" />
        <path
          className="app-whimsy__cloud-sketch"
          d="M13 39c17.5 1 46 .4 69-.2"
        />
      </svg>

      <svg
        className="app-whimsy__cloud app-whimsy__cloud--small"
        viewBox="0 0 70 36"
        focusable="false"
      >
        <path d="M6 29c1.1-5.7 5.2-9.4 11.2-9.4 2.5-8.1 13.6-10.5 19.6-4.2 3-2.1 6.4-2.9 9.9-1.9 5.3 1.5 8.3 5.8 8.5 10.7 5.2.2 8.1 2.2 8.8 4.8H6Z" />
      </svg>

      <span className="app-whimsy__bubble app-whimsy__bubble--one" />
      <span className="app-whimsy__bubble app-whimsy__bubble--two" />
      <span className="app-whimsy__bubble app-whimsy__bubble--three" />
      <span className="app-whimsy__bubble app-whimsy__bubble--four" />

      <svg
        className="app-whimsy__trail"
        viewBox="0 0 98 92"
        focusable="false"
      >
        <path d="M8 73c19 10 44 3 40-15-4-19-28-13-23 4 7 23 43 20 64-5" />
        <path className="app-whimsy__trail-tip" d="m81 53 10 4-8 8" />
      </svg>

      <svg
        className="app-whimsy__spark app-whimsy__spark--one"
        viewBox="0 0 34 34"
        focusable="false"
      >
        <path d="M17 3c.8 8.7 4.9 13 13 14-8.1 1-12.2 5.3-13 14-.8-8.7-4.9-13-13-14 8.1-1 12.2-5.3 13-14Z" />
      </svg>
      <svg
        className="app-whimsy__spark app-whimsy__spark--two"
        viewBox="0 0 30 30"
        focusable="false"
      >
        <path d="M15 4v7M15 19v7M4 15h7M19 15h7M7.5 7.5l5 5M17.5 17.5l5 5M22.5 7.5l-5 5M12.5 17.5l-5 5" />
      </svg>
    </div>
  )
}
