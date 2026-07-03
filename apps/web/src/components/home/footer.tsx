'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { ThemeToggle } from './theme-toggle';

type FooterLinkItem = {
  label: string;
  href: string;
  external?: boolean;
};

const FOOTER_LINKS: FooterLinkItem[] = [
  { label: 'Enterprise', href: '/enterprise' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Docs', href: '/docs' },
  { label: 'Status', href: 'https://status.dosco.live', external: true },
  { label: 'Terms', href: '/legal?tab=terms' },
  { label: 'Privacy', href: '/legal?tab=privacy' },
  { label: 'X', href: 'https://x.com/doscoinc', external: true },
  { label: 'LinkedIn', href: 'https://linkedin.com/company/dosco-inc', external: true },
];

const Footer = () => {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const currentYear = new Date().getFullYear();

  return (
    <footer id="site-footer" className="bg-background relative px-6 py-3">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
        <div className="text-muted-foreground flex items-center gap-3 text-xs">
          <small>
            {tI18nHardcoded.raw('autoComponentsHomeFooterJsxTextCopye99743e8')}
            {currentYear} Dosco, Inc.
          </small>
          <span className="text-muted-foreground/30 hidden sm:inline">|</span>
          <nav className="hidden items-center gap-3 sm:flex">
            {FOOTER_LINKS.map((link) => (
              <Link
                key={link.label}
                href={link.href}
                {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
        <ThemeToggle variant="compact" />
      </div>
    </footer>
  );
};

export default Footer;
