import type { Metadata } from 'next';
import './global.css';

export const metadata: Metadata = {
  title: 'WebCog Experiment Suite',
  description: 'Web Cognitive Load Research Scenarios',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}