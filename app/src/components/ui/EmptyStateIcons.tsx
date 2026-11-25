import type { ReactNode } from "react";

interface IconProps {
  size?: number;
  className?: string;
}

function EmptyStateIcon({ size = 56, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.35}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function EmptyLibraryIcon(props: IconProps) {
  return (
    <EmptyStateIcon {...props}>
      <path d="M14 37H11a2 2 0 0 1-2-2V16a2 2 0 0 1 2-2h31a2 2 0 0 1 2 2v2" opacity=".27" />
      <path d="M19 43h-2a2 2 0 0 1-2-2V22a2 2 0 0 1 2-2h31a2 2 0 0 1 2 2v2" opacity=".48" />
      <rect x="21" y="26" width="34" height="24" rx="2.5" fill="currentColor" fillOpacity=".035" />
      <path d="m42 26 13 13V28.5a2.5 2.5 0 0 0-2.5-2.5Z" fill="var(--accent)" fillOpacity=".19" stroke="none" />
      <path d="m26 44 8-8 6 5 4-3 6 6" opacity=".62" />
      <circle cx="44" cy="33" r="1.5" fill="currentColor" opacity=".55" stroke="none" />
    </EmptyStateIcon>
  );
}

export function NoSearchMatchIcon(props: IconProps) {
  return (
    <EmptyStateIcon {...props}>
      <path d="M9 34V16a2 2 0 0 1 2-2h28a2 2 0 0 1 2 2v3" opacity=".25" />
      <path d="M22 42h-5a2 2 0 0 1-2-2V22a2 2 0 0 1 2-2h26a2 2 0 0 1 2 2v2" opacity=".38" />
      <circle cx="36.5" cy="36.5" r="11.5" fill="var(--accent)" fillOpacity=".09" />
      <path d="m45 45 8 8" />
      <path d="m31.5 41.5 10-10" opacity=".55" />
    </EmptyStateIcon>
  );
}

export function EmptyGenerateIcon(props: IconProps) {
  return (
    <EmptyStateIcon {...props}>
      <rect x="10" y="14" width="44" height="36" rx="3" fill="currentColor" fillOpacity=".035" />
      <path
        d="M15 42c9-1 10-11 19-10 6 1 8 6 15 5v8H15Z"
        fill="var(--accent)"
        fillOpacity=".13"
        stroke="none"
      />
      <path d="M15 42c9-1 10-11 19-10 6 1 8 6 15 5M19 35c4-2 6-6 10-7" opacity=".53" />
      <path d="M41 20c0 4 1 5 5 5-4 0-5 1-5 5 0-4-1-5-5-5 4 0 5-1 5-5Z" fill="var(--accent)" fillOpacity=".18" />
    </EmptyStateIcon>
  );
}

export function EmptyEditIcon(props: IconProps) {
  return (
    <EmptyStateIcon {...props}>
      <path d="M43 14H14a2 2 0 0 0-2 2v25" opacity=".36" />
      <rect x="17" y="19" width="34" height="31" rx="2.5" fill="currentColor" fillOpacity=".035" />
      <path
        d="M23 43c8 1 7-8 13-11 3-2 6-1 9-5-1 6-6 7-9 11-4 6-7 8-13 5Z"
        fill="var(--accent)"
        fillOpacity=".19"
        stroke="none"
      />
      <path d="M23 43c8 1 7-8 13-11 3-2 6-1 9-5" opacity=".8" />
      <path d="M39 39c2-2 4-3 6-4" opacity=".35" />
    </EmptyStateIcon>
  );
}

export function EmptyThreeIcon(props: IconProps) {
  return (
    <EmptyStateIcon {...props}>
      <path d="M10.4 43.5c-3.3-3.9 2.9-12.4 14-19s23-9 28.2-5" opacity=".26" />
      <path d="m32 14 15 8.5v19L32 50l-15-8.5v-19Z" fill="currentColor" fillOpacity=".045" />
      <path d="m32 31 15-8.5v19L32 50Z" fill="var(--accent)" fillOpacity=".14" stroke="none" />
      <path d="m17 22.5 15 8.5 15-8.5M32 31v19" />
      <path d="M10.4 43.5c3.6 4.6 16.9 2 29.2-5.3 10.7-6.4 16.3-14.7 13-18.7" opacity=".42" />
    </EmptyStateIcon>
  );
}

export function EmptyQueueIcon(props: IconProps) {
  return (
    <EmptyStateIcon {...props}>
      <path d="M20 18v-2a2 2 0 0 1 2-2h20a2 2 0 0 1 2 2v2" opacity=".28" />
      <path d="M16 25v-3a2 2 0 0 1 2-2h28a2 2 0 0 1 2 2v3" opacity=".46" />
      <path d="M13 34v-4a2 2 0 0 1 2-2h34a2 2 0 0 1 2 2v4" fill="currentColor" fillOpacity=".05" opacity=".72" />
      <path d="M11 36h13l3.5 5h9l3.5-5h13v10a4 4 0 0 1-4 4H15a4 4 0 0 1-4-4Z" fill="var(--accent)" fillOpacity=".11" />
    </EmptyStateIcon>
  );
}

export function BlenderIcon({ size = 16, colored = false, className }: IconProps & { colored?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden="true">
      <path
        fill={colored ? "#EA7600" : "currentColor"}
        fillRule="evenodd"
        d="M58.8 26.5 36.5 9.3a4 4 0 0 0-5.6.7 3.5 3.5 0 0 0 .7 5L41 22H15.8a4.5 4.5 0 0 0-4.6 4.1c-.2 2.1 1.7 3.7 4.1 3.7h11.8L5.4 46.1a4.1 4.1 0 0 0-.9 5.9 4.5 4.5 0 0 0 6.1.3l10.7-8.7C23.1 51.2 31.4 57 41.7 57 53.5 57 63 49 63 39.1c0-5.1-1.7-9.3-4.2-12.6ZM41.7 48.8c-7.7 0-13.9-4.5-13.9-10s6.2-10 13.9-10 13.9 4.5 13.9 10-6.2 10-13.9 10Z"
      />
      <ellipse cx="41.7" cy="38.8" rx="10.1" ry="7" fill={colored ? "#265787" : "currentColor"} />
    </svg>
  );
}
