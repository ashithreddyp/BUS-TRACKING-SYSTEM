import ModalDialog from "./ModalDialog";

export default function AppModals({
  pendingExistingStop,
  useNearbyExistingStop,
  createNewStopFromNearbyChoice,
  cancelPinnedStop,
  pendingStopPoint,
  pendingStopName,
  setPendingStopName,
  savePinnedStop,
  incidentPrompt,
  removeIncident,
  setIncidentPromptQueue,
  showLogin,
  password,
  setPassword,
  loginAdmin,
  setShowLogin,
  confirm,
  setConfirm
}) {
  return (
    <>
      {pendingExistingStop && (
        <ModalDialog
          title="Nearby Stop Found"
          message={`"${pendingExistingStop.stopName}" is about ${pendingExistingStop.distanceMeters}m away. Use the same stop for this route?`}
        >
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={useNearbyExistingStop}>Use Existing Stop</button>
            <button className="btn btn-secondary" onClick={createNewStopFromNearbyChoice}>Create New Stop</button>
          </div>
          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={cancelPinnedStop}>Cancel</button>
          </div>
        </ModalDialog>
      )}

      {pendingStopPoint && !pendingExistingStop && (
        <ModalDialog title="Name New Stop">
          <input
            className="input"
            placeholder="Stop name"
            value={pendingStopName}
            onChange={e => setPendingStopName(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") {
                e.preventDefault();
                savePinnedStop();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                cancelPinnedStop();
              }
            }}
          />
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={savePinnedStop}>Save Stop</button>
            <button className="btn btn-secondary" onClick={cancelPinnedStop}>Cancel</button>
          </div>
        </ModalDialog>
      )}

      {incidentPrompt && (
        <ModalDialog
          title="Incident Review"
          message={`Incident "${incidentPrompt.incidentType}" has been active for ${incidentPrompt.ageMinutes} minutes.`}
        >
          <p>Remove it now if cleared?</p>
          <div className="modal-actions">
            <button
              className="btn btn-danger"
              onClick={() => removeIncident(incidentPrompt.incidentId)}
            >
              Remove Incident
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => setIncidentPromptQueue(prev => prev.slice(1))}
            >
              Later
            </button>
          </div>
        </ModalDialog>
      )}

      {showLogin && (
        <ModalDialog title="Admin Login">
          <input
            type="password"
            className="input"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") {
                e.preventDefault();
                loginAdmin();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setShowLogin(false);
              }
            }}
          />
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={loginAdmin}>Login</button>
            <button className="btn btn-secondary" onClick={() => setShowLogin(false)}>Cancel</button>
          </div>
        </ModalDialog>
      )}

      {confirm && (
        <ModalDialog title={confirm.title} message={confirm.message}>
          <button className="btn btn-secondary" onClick={() => setConfirm(null)}>Close</button>
        </ModalDialog>
      )}
    </>
  );
}
