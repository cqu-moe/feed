import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import './source-directory.css';

export function DirectorySite({ name, count, totals, reveal, children }: {
  name: string; count: string; totals: ReactNode; reveal?: boolean; children: ReactNode;
}) {
  return <details className="directory-site" open={reveal || undefined}>
    <summary className="directory-row">
      <strong>{name}</strong><small>{count}</small><span className="directory-totals">{totals}</span>
      <ChevronRight className="directory-chevron" aria-hidden="true" />
    </summary>
    <div className="directory-columns">{children}</div>
  </details>;
}

export function DirectoryEntry({ title, badge, reveal, children }: {
  title: ReactNode; badge: ReactNode; reveal?: boolean; children: ReactNode;
}) {
  return <details className="directory-column" open={reveal || undefined}>
    <summary className="directory-row">
      <ChevronRight className="directory-chevron" aria-hidden="true" /><span>{title}</span>{badge}
    </summary>
    {children}
  </details>;
}
