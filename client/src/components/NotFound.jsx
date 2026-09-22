/** Client-side 404 for an address that matches no route. */
import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <main className="login-shell">
      <div className="login-card card text-center">
        <h1>Page not found</h1>
        <p className="text-muted mt-8">That address does not exist on QR Shield.</p>
        <Link className="btn btn-primary btn-block mt-16" to="/">
          Check a medicine pack
        </Link>
      </div>
    </main>
  );
}
