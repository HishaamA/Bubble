export type Memory = {
  id: string
  label: string
  date: string
  position: { top: string; left: string; size: string }
  crop: { left: number; top: number; diameter: number }
  featured?: boolean
}

export const memories: Memory[] = [
  {
    id: 'campfire',
    label: 'Autumn campfire',
    date: 'October 18',
    position: { top: '5%', left: '15%', size: 'clamp(3.9rem, 14vw, 5rem)' },
    crop: { left: 268, top: 171, diameter: 76 },
  },
  {
    id: 'grandparents',
    label: 'Granddad’s birthday',
    date: 'November 2',
    position: { top: '7%', left: '53%', size: 'clamp(4.6rem, 16vw, 5.8rem)' },
    crop: { left: 413, top: 188, diameter: 92 },
  },
  {
    id: 'beach',
    label: 'Beach day',
    date: 'July 9',
    position: { top: '17%', left: '70%', size: 'clamp(5.2rem, 19vw, 6.8rem)' },
    crop: { left: 519, top: 266, diameter: 112 },
  },
  {
    id: 'birthday',
    label: 'Maya’s birthday',
    date: 'August 25',
    position: { top: '20%', left: '2%', size: 'clamp(6.2rem, 24vw, 8.6rem)' },
    crop: { left: 212, top: 275, diameter: 150 },
  },
  {
    id: 'dinner',
    label: 'Sunday dinner',
    date: 'Last Sunday',
    position: { top: '35%', left: '24%', size: 'clamp(10.7rem, 43vw, 14rem)' },
    crop: { left: 313, top: 395, diameter: 250 },
    featured: true,
  },
  {
    id: 'sunset',
    label: 'Sunset walk',
    date: 'June 14',
    position: { top: '42%', left: '83%', size: 'clamp(3.2rem, 11vw, 4.2rem)' },
    crop: { left: 594, top: 452, diameter: 63 },
  },
  {
    id: 'wedding',
    label: 'Leena and Omar’s wedding',
    date: 'March 16',
    position: { top: '61%', left: '1%', size: 'clamp(5.2rem, 19vw, 7rem)' },
    crop: { left: 209, top: 578, diameter: 126 },
  },
  {
    id: 'graduation',
    label: 'Graduation day',
    date: 'May 30',
    position: { top: '61%', left: '70%', size: 'clamp(4.7rem, 17vw, 6.2rem)' },
    crop: { left: 545, top: 581, diameter: 114 },
  },
  {
    id: 'mountains',
    label: 'Mountain trip',
    date: 'April 12',
    position: { top: '73%', left: '47%', size: 'clamp(4.6rem, 17vw, 6rem)' },
    crop: { left: 442, top: 696, diameter: 111 },
  },
  {
    id: 'cousins',
    label: 'Cousins together',
    date: 'January 4',
    position: { top: '78%', left: '15%', size: 'clamp(4rem, 14vw, 5.1rem)' },
    crop: { left: 264, top: 749, diameter: 86 },
  },
]
