import Link from 'next/link';
export default function NotFoundPage() {
  return (
    <main style={{ padding: 32 }}>
      <h1>QeyNox Control</h1>
      <p>This control page does not exist. / Cette page de contrôle n'existe pas.</p>
      <Link href="/en">Overview / Vue d'ensemble</Link>
    </main>
  );
}
