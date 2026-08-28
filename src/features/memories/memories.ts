export type Memory = {
  id: string
  label: string
  date: string
  sender: string
  thumbnail: string
  position: { top: string; left: string }
}

export const memories: Memory[] = [
  {
    id: 'dinner',
    label: 'Sunday dinner',
    date: 'Last Sunday',
    sender: 'Mum',
    thumbnail: '/assets/journal/demo/demo-album-sunday.png',
    position: { top: '45%', left: '40%' },
  },
]
