export const metadata = { title: "Dashboard" };

// PLACEHOLDER: there is no sign-in or database yet, so this page shows an honest empty state.
// Replace with real data once authentication (Phase 2) and the database exist.
export default function DashboardPage() {
  return (
    <>
      <h1>Dashboard</h1>
      <p role="note" className="notice">Sign-in and the database are not connected yet, so there is no account data to show.</p>
    </>
  );
}
