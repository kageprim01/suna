import Hero from '@/features/marketing/hero';

export default function Home() {
  return (
    <div className="bg-background relative min-h-screen flex flex-col">
      <Hero />
      <footer className="text-muted-foreground mx-auto w-full max-w-7xl px-6 py-2 text-center text-xs">
        &copy; 2026 Dosco Inc.
      </footer>
    </div>
  );
}
