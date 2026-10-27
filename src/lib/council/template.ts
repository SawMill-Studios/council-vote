/** Today's council, copied into each new session. A session may replace any of these strings. */

export interface BeatCopy {
  n: 1 | 2 | 3 | 4;
  kicker: string;
  title: string;
  prompt: string;
  notes: string;
}

export interface FramingCopy {
  leadsTitle: string;
  leadsBody: string;
  middleTitle: string;
  middleBody: string;
  buildersTitle: string;
  buildersBody: string;
  gap1Title: string;
  gap1Body: string;
  gap2Title: string;
  gap2Body: string;
}

export interface CaptureCopy {
  heading: string;
  sub: string;
  pmHeading: string;
  moves: string;
}

export interface BoardCopy {
  title: string;
  shortName: string;
  /** Phone line while the room is still on the framing beat. */
  waiting: string;
  columns: {
    pm: string;
    channel: string;
    testing: string;
    harvest: string;
  };
  beats: BeatCopy[];
  framing: FramingCopy;
  capture: CaptureCopy;
}

export function defaultBoardCopy(title = "EC6 council"): BoardCopy {
  const copy: BoardCopy = {
    title,
    shortName: "EC6",
    waiting: "Darren is framing. Your first prompt is coming. This phone will follow the big screen.",
    columns: {
      pm: "PM skills",
      channel: "Where to hunt",
      testing: "Testing",
      harvest: "Harvest",
    },
    beats: [
      {
        n: 1,
        kicker: "Beat 1 of 4 · Framing",
        title: "The barbell is working.",
        prompt: "Strategy, shaping, architecture, coaching, hiring",
        notes:
          "Leads on one end, builders on the other, agents in the middle. Two gaps: hiring and testing. Do not say: anything about buyouts, today's announcement beyond \"return-to-office requirement,\" headcount or layoff numbers, the Warner deal, or any candidate's name. If someone asks about today's news: Fair question, but not for this half hour. Ask me at lunch.",
      },
      {
        n: 2,
        kicker: "Beat 2 of 4 · Hiring wall",
        title: "Hire for what? Hunt where?",
        prompt: "2 dots on skills you would hire for tomorrow. 1 dot on the channel you would try first.",
        notes:
          "Open the vote with V. Two skill dots, and both may land on one sticky. One hunt dot. R re-ranks and numbers the top three. M merges two stickies. Shift+M splits the selected stack.",
      },
      {
        n: 3,
        kicker: "Beat 3 of 4 · Testing 2x2",
        title: "How do lean teams actually test?",
        prompt: "Place a today dot, then a 1 year dot. Be honest, not the board deck.",
        notes:
          "R hides the arrows so the room sees today before the year ahead. The room-average arrow appears once three people have placed both dots.",
      },
      {
        n: 4,
        kicker: "Beat 4 of 4 · Harvest",
        title: "I'll give you ___",
        prompt: "An intro, a channel, a template, or 20 minutes on the phone.",
        notes: "Names show on offers. E downloads the capture sheet, JSON, and CSV.",
      },
    ],
    framing: {
      leadsTitle: "Leads",
      leadsBody: "Strategy, coaching, hiring, org design",
      middleTitle: "Agents in the middle",
      middleBody: "AI does the old middle-management work",
      buildersTitle: "Builders",
      buildersBody: "Cross-functional makers who ship to production",
      gap1Title: "Gap 1 · Hiring",
      gap1Body: "Brand headlines, return to office, big-tech pay. Recruiters don't know where to hunt yet.",
      gap2Title: "Gap 2 · Testing",
      gap2Body: "We ship more than we can validate. No research lead, no A/B owner.",
    },
    capture: {
      heading: "Capture Sheet: Hiring and Testing for the Five-Years-Forward Org",
      sub: "EC6 Philadelphia · Tue Oct 27, 2026 · Scribe: ____________________ · Photograph both walls before they come down.",
      pmHeading: "PM skill cluster",
      moves: "Darren's next three moves",
    },
  };
  if (title !== "EC6 council") copy.shortName = [...title].slice(0, 24).join("");
  return copy;
}
