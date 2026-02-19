import { Suspense } from 'react';

import { ProTerminal } from './pro-terminal';

export default function ProPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#06111d]" />}>
      <ProTerminal />
    </Suspense>
  );
}
