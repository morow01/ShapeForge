/* Small line icons for the Home sidebar, drawn to match each other: 16px, 1.8 stroke. */

type IconProps = { className?: string; size?: number };

function Svg({ className, size = 16, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const GridIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
  </Svg>
);

export const ClockIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);

export const StarIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z" />
  </Svg>
);

export const FolderIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
);

/** A hash sign: tags are written #like-this. */
export const TagIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 3.5 7.5 20.5M16.5 3.5l-2 17M4 9h16.5M3.5 15H20" />
  </Svg>
);

export const MonitorIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </Svg>
);

export const CloudIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 18.5a4.5 4.5 0 0 1-.7-8.95A6 6 0 0 1 17.8 10.2 4.15 4.15 0 0 1 17 18.5z" />
  </Svg>
);

export const DraftIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 3.5h7l4 4v13H7z" strokeDasharray="3 2.2" />
    <path d="M14 3.5v4h4" />
  </Svg>
);

export const BinIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M9.5 7V4.5h5V7M6 7l1 13h10l1-13M10 11v6M14 11v6" />
  </Svg>
);
