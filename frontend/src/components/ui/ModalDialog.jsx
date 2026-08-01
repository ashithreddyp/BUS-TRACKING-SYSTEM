export default function ModalDialog({ title, message, children }) {
  return (
    <div className="login-overlay">
      <div className="login-box">
        {title && <h3>{title}</h3>}
        {message && <p>{message}</p>}
        {children}
      </div>
    </div>
  );
}
