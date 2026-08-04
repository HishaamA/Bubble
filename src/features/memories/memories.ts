export type Memory = {
  id: string
  label: string
  date: string
  sender: string
  position: { top: string; left: string }
  crop: { left: number; top: number; diameter: number }
}

export const memories: Memory[] = [
  {
    id: 'campfire',
    label: 'Autumn campfire',
    date: 'October 18',
    sender: 'Dad',
    position: { top: '7%', left: '8%' },
    crop: { left: 268, top: 171, diameter: 76 },
  },
  {
    id: 'grandparents',
    label: 'Granddad’s birthday',
    date: 'November 2',
    sender: 'Simreen',
    position: { top: '8%', left: '45%' },
    crop: { left: 413, top: 188, diameter: 92 },
  },
  {
    id: 'beach',
    label: 'Beach day',
    date: 'July 9',
    sender: 'Hishaam',
    position: { top: '10%', left: '78%' },
    crop: { left: 519, top: 266, diameter: 112 },
  },
  {
    id: 'birthday',
    label: 'Maya’s birthday',
    date: 'August 25',
    sender: 'Maya',
    position: { top: '29%', left: '16%' },
    crop: { left: 212, top: 275, diameter: 150 },
  },
  {
    id: 'dinner',
    label: 'Sunday dinner',
    date: 'Last Sunday',
    sender: 'Mum',
    position: { top: '45%', left: '40%' },
    crop: { left: 313, top: 395, diameter: 250 },
  },
  {
    id: 'sunset',
    label: 'Sunset walk',
    date: 'June 14',
    sender: 'Simreen',
    position: { top: '32%', left: '83%' },
    crop: { left: 594, top: 452, diameter: 63 },
  },
  {
    id: 'wedding',
    label: 'Leena and Omar’s wedding',
    date: 'March 16',
    sender: 'Mum',
    position: { top: '62%', left: '6%' },
    crop: { left: 209, top: 578, diameter: 126 },
  },
  {
    id: 'graduation',
    label: 'Graduation day',
    date: 'May 30',
    sender: 'Sara',
    position: { top: '62%', left: '72%' },
    crop: { left: 545, top: 581, diameter: 114 },
  },
  {
    id: 'mountains',
    label: 'Mountain trip',
    date: 'April 12',
    sender: 'Hishaam',
    position: { top: '80%', left: '49%' },
    crop: { left: 442, top: 696, diameter: 111 },
  },
  {
    id: 'cousins',
    label: 'Cousins together',
    date: 'January 4',
    sender: 'Maya',
    position: { top: '84%', left: '18%' },
    crop: { left: 264, top: 749, diameter: 86 },
  },
]
