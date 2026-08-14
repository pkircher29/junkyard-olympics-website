export const demo = {
  event: { name: 'Junkyard Olympics', date: 'Saturday · 2:00 PM', phase: 'Field events live', wifi: 'Junkyard Olympics' },
  me: { id: 'p1', name: 'Rivet Rosie', status: 'CALLED NOW', cooldown: 'Ready to play', points: 25, rank: 2, eligible: true, counted: ['Cannon · 10', 'Cornhole · 7', 'Ladder Ball · 5', 'KanJam · 3'], dropped: ['Field Pong · 1'], flair: 8 },
  events: [
    { id:'cannon', name:'Junkyard Cannon', joined:true, status:'Complete · 1st' },
    { id:'ladder', name:'Ladder Ball', joined:true, status:'Quarterfinal' },
    { id:'pong', name:'Field Pong', joined:true, status:'Complete · 5th' },
    { id:'cornhole', name:'Cornhole', joined:true, status:'Semifinal' },
    { id:'kanjam', name:'KanJam', joined:true, status:'On deck' },
  ],
  activeMatch: { id:'m18', event:'Cornhole', station:'The Crusher', team:'Rusted Legends', players:'Rivet Rosie + Dumpster Dan', opponent:'Trash Pandas', opponents:'Mad Maxine + Bolt Cutter Bob', deadline:'04:12' },
  matches: [
    { station:'THE CRUSHER', event:'Cornhole · Semifinal', a:'Rusted Legends', ap:'Rosie + Dan', b:'Trash Pandas', bp:'Maxine + Bob', status:'CHECK IN NOW' },
    { station:'BARREL 2', event:'KanJam · Quarterfinal', a:'Hot Mess Express', ap:'Tina + Gary', b:'Scrap Pack', bp:'Lee + Jo', status:'PLAYING' },
    { station:'TIRE FIRE', event:'Ladder Ball · Round 1', a:'Loose Screws', ap:'Moe + Sal', b:'Bad Bearings', bp:'Pat + Kim', status:'ON DECK' },
  ],
  standings: [
    { rank:1, name:'Dumpster Dan', total:27, counted:'10 + 7 + 5 + 5', dropped:'Pong 3', eligible:true },
    { rank:2, name:'Rivet Rosie', total:25, counted:'10 + 7 + 5 + 3', dropped:'Pong 1', eligible:true },
    { rank:3, name:'Mad Maxine', total:22, counted:'7 + 7 + 5 + 3', dropped:'—', eligible:true },
    { rank:4, name:'Bolt Cutter Bob', total:19, counted:'5 + 7 + 5 + 2', dropped:'—', eligible:false },
    { rank:5, name:'Tetanus Tina', total:17, counted:'7 + 5 + 3 + 2', dropped:'—', eligible:true },
  ],
  flair: [
    { name:'Tetanus Tina', points:14, note:'Unnecessary Showmanship × 4' },
    { name:'Dumpster Dan', points:11, note:'Spectacular Destruction × 2' },
    { name:'Rivet Rosie', points:8, note:'Junkyard Ingenuity × 3' },
  ],
  participants: ['Rivet Rosie','Dumpster Dan','Mad Maxine','Bolt Cutter Bob','Tetanus Tina','Gary the Wrench','Scrap Metal Sal','Loose Screw Lou','KanJam Kim','Pallet Pat'],
  queue: [
    { n:1, event:'Cornhole', teams:'Rusted Legends vs Trash Pandas', state:'Both checked in' },
    { n:2, event:'Ladder Ball', teams:'Loose Screws vs Bad Bearings', state:'On deck' },
    { n:3, event:'Field Pong', teams:'The Compactors vs Rust Buckets', state:'Queued' },
  ],
  cannon: {
    targets:[{name:'Million Point Washer',value:'1,000,000',jackpot:true},{name:'Rusty Hubcap',value:25},{name:'Paint Can',value:10},{name:'Traffic Cone',value:5}],
    lanes:[
      { id:'lane-a', name:'LANE A', team:'Dumpster Fire', players:'Dan + Rosie', shot:14, total:185, last:'Hubcap + Paint Can = 35' },
      { id:'lane-b', name:'LANE B', team:'Wrecking Crew', players:'Maxine + Bob', shot:13, total:160, last:'MISS = 0' },
    ]
  },
  audit:[
    '3:42 PM · Chris confirmed Carnage Bonus · Dumpster Fire',
    '3:39 PM · Paul resolved result · Field Pong M12',
    '3:35 PM · System called Cornhole semifinal · The Crusher',
  ]
};
