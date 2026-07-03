'use client';

import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { UnicornBackground } from '@/components/ui/unicorn-background';
import { vujahdayScript } from '@/app/(system)/fonts/vujahday-script';
import { Button } from '@/components/ui/marketing/button';

const TAGLINES = [
  {
    tagline: 'The Autonomous Agent Platform',
    subtitle: 'Your AI coworker, not another chatbot.',
  },
  {
    tagline: 'Secure Agents in Secure Environments',
    subtitle: 'Enterprise-grade isolation, built in.',
  },
  {
    tagline: 'One Query \u2192 One Deliverable',
    subtitle: 'We ship complete work, not just text.',
  },
  {
    tagline: 'Agents That Ship, Not Just Chat',
    subtitle: 'Results, not rambling.',
  },
];

function AnimatedTagline() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setIndex((i) => (i + 1) % TAGLINES.length), 6000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="relative flex flex-col items-center gap-4">
      <AnimatePresence mode="wait">
        <motion.span
          key={TAGLINES[index].tagline}
          className={`text-foreground text-center text-4xl leading-tight font-light tracking-tight md:text-6xl lg:text-7xl italic ${vujahdayScript.className}`}
          initial={{ opacity: 0, filter: 'blur(4px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, filter: 'blur(4px)' }}
          transition={{ duration: 0.5, ease: 'easeInOut' }}
        >
          {TAGLINES[index].tagline}
        </motion.span>
      </AnimatePresence>
      <span className="text-muted-foreground text-lg md:text-xl">火</span>
      <AnimatePresence mode="wait">
        <motion.span
          key={TAGLINES[index].subtitle}
          className="text-muted-foreground text-center text-base md:text-lg text-balance"
          initial={{ opacity: 0, filter: 'blur(4px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, filter: 'blur(4px)' }}
          transition={{ duration: 0.4, delay: 0.1, ease: 'easeInOut' }}
        >
          {TAGLINES[index].subtitle}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

const Hero = () => {
  return (
    <section id="hero" className="relative h-screen w-full overflow-hidden">
      <div className="absolute inset-0 z-0">
        <UnicornBackground />
      </div>

      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center px-6">
        <motion.div
          className="grid place-items-center"
          initial={{ opacity: 0, filter: 'blur(4px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
          style={{ willChange: 'opacity, filter', transform: 'translateZ(0)' }}
        >
          <AnimatedTagline />
        </motion.div>
        <motion.div
          className="mt-10 flex items-center gap-4"
          initial={{ opacity: 0, filter: 'blur(4px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          transition={{ duration: 0.6, delay: 0.6, ease: 'easeOut' }}
          style={{ willChange: 'opacity, filter', transform: 'translateZ(0)' }}
        >
          <Button size="xl" asChild>
            <Link href="/auth">Get started</Link>
          </Button>
          <Button size="xl" variant="outline" asChild>
            <Link href="/showcase">See Agentica in action</Link>
          </Button>
        </motion.div>
      </div>
    </section>
  );
};

export default Hero;
