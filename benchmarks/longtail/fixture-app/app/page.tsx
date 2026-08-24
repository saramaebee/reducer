import dayjs from 'dayjs';

export const dynamic = 'force-dynamic';

/** The common happy path: the landing page every visitor gets. */
export default function Home() {
  return (
    <main>
      <h1>longtail fixture</h1>
      <p data-testid="stamp">{dayjs(0).format('YYYY-MM-DD')}</p>
    </main>
  );
}
