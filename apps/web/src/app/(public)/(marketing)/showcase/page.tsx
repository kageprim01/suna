'use client';

import { HowItWorks } from '@/features/marketing/how-it-work/how-it-works';
import { SurfacesSection } from '@/features/marketing/surfaces-section';
import { WhyAgentica } from '@/features/marketing/why-kortix';
import Security from '@/features/marketing/security/security';
import { CtaSection } from '@/features/marketing/cta-section';

export default function ShowcasePage() {
  return (
    <div className="bg-background relative">
      <section className="mx-auto flex max-w-6xl flex-col px-6 pt-32 pb-16 sm:pb-24 xl:px-0">
        <p className="text-muted-foreground text-sm">Showcase</p>
        <h1 className="text-foreground mt-2 text-3xl leading-tight font-medium tracking-tight sm:text-4xl md:text-5xl">
          See Agentica in action
        </h1>
        <p className="text-muted-foreground mt-3 max-w-2xl text-base leading-relaxed md:text-lg">
          Watch AI agents do real work across your tools — from research and
          analysis to execution and delivery.
        </p>
      </section>

      <HowItWorks />
      <SurfacesSection />
      <WhyAgentica />
      <Security />

      <section className="pb-24 sm:pb-32">
        <CtaSection />
      </section>
    </div>
  );
}
