'use client';

import { Button } from '@/components/ui/marketing/button';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import Link from 'next/link';
import { useCallback } from 'react';

export function CtaSection() {
  const { user } = useAuth();

  const handleLaunch = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  return (
    <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0">
      <div className="border-border bg-card relative overflow-hidden rounded-sm border text-center">
        <div className="px-6 py-16 sm:px-12 sm:py-20">
          <h2 className="text-foreground text-3xl leading-tight font-medium tracking-tight sm:text-4xl">
            Create the first AI coworker
            <br />
            your team will actually use.
          </h2>
          <p className="text-muted-foreground mx-auto mt-4 max-w-lg text-base leading-relaxed text-balance">
            Managed cloud from $20/month. No trick, no time limit.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button size="xl" onClick={handleLaunch}>
              <span className="text-base">火</span>
              Get started
            </Button>
            <Button size="xl" variant="secondary" asChild>
              <Link href={'/enterprise'}>Talk to Sales</Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
