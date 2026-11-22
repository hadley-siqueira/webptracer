/** Generic network icons (original drawings, no vendor logos). Centered at 0,0, ~56px wide. */
export function DeviceIcon({ kind, powered = true }: { kind: string; powered?: boolean }) {
  const dim = powered ? 1 : 0.45;
  switch (kind) {
    case 'router':
      return (
        <g opacity={dim}>
          <ellipse cx="0" cy="8" rx="28" ry="10" fill="#1e5a8a" />
          <rect x="-28" y="-6" width="56" height="14" fill="#2876b4" />
          <ellipse cx="0" cy="-6" rx="28" ry="10" fill="#3b8fd1" stroke="#1e5a8a" />
          <g stroke="white" strokeWidth="2.4" fill="none" strokeLinecap="round">
            <path d="M-16 -6 h9 M-10 -9 l3 3 -3 3" />
            <path d="M16 -6 h-9 M10 -9 l-3 3 3 3" />
            <path d="M0 -15 v5 M-3 -12 l3 -3 3 3" />
            <path d="M0 3 v-5 M-3 0 l3 3 3 -3" />
          </g>
        </g>
      );
    case 'switch':
    case 'l3switch':
      return (
        <g opacity={dim}>
          <path d="M-30 -8 L-22 -16 H30 L22 -8 Z" fill="#4ea3dd" stroke="#1e5a8a" />
          <rect x="-30" y="-8" width="52" height="20" fill="#2876b4" stroke="#1e5a8a" />
          <path d="M22 -8 L30 -16 V4 L22 12 Z" fill="#1e5a8a" />
          <g stroke="white" strokeWidth="2.2" fill="none" strokeLinecap="round">
            <path d="M-22 -2 h14 M-11 -5 l3 3 -3 3" />
            <path d="M14 6 h-14 M3 3 l-3 3 3 3" />
          </g>
          {kind === 'l3switch' && (
            <g>
              <circle cx="-22" cy="-12" r="0" />
              <text x="-4" y="-10" fontSize="7" fill="white" fontWeight="bold" textAnchor="middle">L3</text>
            </g>
          )}
        </g>
      );
    case 'hub':
      return (
        <g opacity={dim}>
          <rect x="-26" y="-10" width="52" height="20" rx="3" fill="#7c8a97" stroke="#4b5563" />
          {[-18, -9, 0, 9, 18].map((x) => (
            <rect key={x} x={x - 3} y="-3" width="6" height="6" fill="#1f2937" />
          ))}
        </g>
      );
    case 'pc':
      return (
        <g opacity={dim}>
          <rect x="-22" y="-20" width="44" height="30" rx="2" fill="#374151" />
          <rect x="-19" y="-17" width="38" height="24" fill={powered ? '#60a5fa' : '#1f2937'} />
          <rect x="-4" y="10" width="8" height="6" fill="#4b5563" />
          <rect x="-14" y="16" width="28" height="4" rx="1" fill="#4b5563" />
        </g>
      );
    case 'laptop':
      return (
        <g opacity={dim}>
          <rect x="-18" y="-18" width="36" height="24" rx="2" fill="#374151" />
          <rect x="-15" y="-15" width="30" height="18" fill={powered ? '#93c5fd' : '#1f2937'} />
          <path d="M-24 6 H24 L20 13 H-20 Z" fill="#6b7280" />
        </g>
      );
    case 'server':
      return (
        <g opacity={dim}>
          <rect x="-16" y="-24" width="32" height="46" rx="2" fill="#374151" />
          {[-18, -8, 2].map((y) => (
            <g key={y}>
              <rect x="-12" y={y} width="24" height="7" fill="#4b5563" />
              <circle cx="8" cy={y + 3.5} r="1.6" fill={powered ? '#22c55e' : '#111'} />
            </g>
          ))}
        </g>
      );
    default:
      return <circle r="20" fill="#999" />;
  }
}
