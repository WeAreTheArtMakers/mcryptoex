import dynamic from 'next/dynamic';

const ProTerminal = dynamic(() => import('./pro-terminal').then((mod) => mod.ProTerminal), {
  ssr: false,
  loading: () => <div className="min-h-screen bg-[#06111d]" />
});

export default function ProPage() {
  return <ProTerminal />;
}
