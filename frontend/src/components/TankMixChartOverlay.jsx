import React, { useEffect, useRef, useState } from 'react';
import { OVERLAY_EXIT_MS } from '../lib/useAnimatedPresence';

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function TankMixChartOverlay({ onClose }) {
  const [closing, setClosing] = useState(false);
  const closedRef = useRef(false);

  const requestClose = () => {
    if (closedRef.current || closing) return;
    if (prefersReducedMotion()) {
      closedRef.current = true;
      onClose();
      return;
    }
    setClosing(true);
  };

  useEffect(() => {
    if (!closing) return undefined;
    const timer = window.setTimeout(() => {
      if (closedRef.current) return;
      closedRef.current = true;
      onClose();
    }, OVERLAY_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [closing, onClose]);

  // Prevent clicks inside the modal from bubbling up to the backdrop
  const handleModalClick = (e) => e.stopPropagation();

  return (
    <div
      className={`tank-mix-backdrop${closing ? ' tank-mix-backdrop--closing' : ''}`}
      onClick={requestClose}
    >
      <style>{`
        .tank-mix-backdrop {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: rgba(9, 17, 31, 0.85);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 9999;
          padding: 16px;
          animation: tank-mix-backdrop-in 0.18s ease-out;
        }

        .tank-mix-modal {
          background-color: #0f172a;
          border: 1px solid rgba(143, 182, 255, 0.18);
          border-radius: 16px;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
          width: 100%;
          max-width: 900px;
          max-height: 90vh;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          animation: tank-mix-card-in 0.2s ease-out;
        }

        @keyframes tank-mix-backdrop-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        @keyframes tank-mix-card-in {
          from { opacity: 0; transform: scale(0.96); }
          to { opacity: 1; transform: scale(1); }
        }

        @keyframes tank-mix-backdrop-out {
          from { opacity: 1; }
          to { opacity: 0; }
        }

        @keyframes tank-mix-card-out {
          from { opacity: 1; transform: scale(1); }
          to { opacity: 0; transform: scale(0.96); }
        }

        .tank-mix-backdrop--closing {
          animation: tank-mix-backdrop-out 0.18s ease-in forwards;
          pointer-events: none;
        }

        .tank-mix-backdrop--closing .tank-mix-modal {
          animation: tank-mix-card-out 0.2s ease-in forwards;
        }

        @media (prefers-reduced-motion: reduce) {
          .tank-mix-backdrop,
          .tank-mix-modal,
          .tank-mix-backdrop--closing,
          .tank-mix-backdrop--closing .tank-mix-modal {
            animation: none;
          }
        }

        .tank-mix-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px 20px;
          background-color: rgba(15, 23, 42, 0.95);
          border-bottom: 1px solid rgba(143, 182, 255, 0.12);
        }

        .tank-mix-title {
          font-size: 1.25rem;
          font-weight: 700;
          color: #ffffff;
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 0;
        }

        .tank-mix-close-x {
          background: transparent;
          border: none;
          color: #9ab1d6;
          font-size: 1.25rem;
          font-weight: 400;
          cursor: pointer;
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 8px;
          transition: all 0.15s ease;
        }

        .tank-mix-close-x:hover {
          background-color: rgba(143, 182, 255, 0.1);
          color: #ffffff;
        }

        .tank-mix-content {
          padding: 20px;
          overflow-y: auto;
          flex: 1;
        }

        .tank-mix-table-wrapper {
          overflow-x: auto;
          border-radius: 12px;
          border: 1px solid rgba(143, 182, 255, 0.12);
          background-color: #09111f;
        }

        .tank-mix-table {
          width: 100%;
          border-collapse: collapse;
          text-align: left;
          font-size: 0.9rem;
          color: #c6d6f1;
        }

        .tank-mix-table th {
          padding: 12px 16px;
          font-weight: 600;
          white-space: nowrap;
        }

        .tank-mix-table th.header-standard {
          background-color: #1e293b;
          color: #ffffff;
        }

        .tank-mix-table th.header-yellow {
          background-color: #f59e0b;
          color: #0f172a;
          font-weight: 700;
        }

        .tank-mix-table th.header-green {
          background-color: #10b981;
          color: #0f172a;
          font-weight: 700;
        }

        .tank-mix-table th.header-pink {
          background-color: #ec4899;
          color: #0f172a;
          font-weight: 700;
        }

        .tank-mix-table td {
          padding: 12px 16px;
          border-bottom: 1px solid rgba(143, 182, 255, 0.08);
        }

        .tank-mix-table tr:last-child td {
          border-bottom: none;
        }

        .tank-mix-table tr:hover {
          background-color: rgba(143, 182, 255, 0.03);
        }

        .tank-mix-herbicide-name {
          color: #ffffff;
          font-weight: 600;
        }

        .tank-mix-value {
          font-weight: 500;
        }

        .tank-mix-surfactant-yes {
          color: #34d399;
          font-weight: 700;
        }

        .tank-mix-instructions {
          color: #94a3b8;
          font-size: 0.85rem;
          line-height: 1.4;
          min-width: 250px;
        }

        .tank-mix-footer {
          display: flex;
          justify-content: flex-end;
          padding: 16px 20px;
          background-color: rgba(15, 23, 42, 0.95);
          border-top: 1px solid rgba(143, 182, 255, 0.12);
        }

        .tank-mix-close-btn {
          padding: 10px 24px;
          background-color: #2563eb;
          color: #ffffff;
          border: none;
          border-radius: 8px;
          font-weight: 600;
          cursor: pointer;
          transition: background-color 0.15s ease;
        }

        .tank-mix-close-btn:hover {
          background-color: #1d4ed8;
        }

        @media (max-width: 640px) {
          .tank-mix-backdrop {
            padding: 8px;
          }
          .tank-mix-modal {
            max-height: 96vh;
            border-radius: 8px;
          }
          .tank-mix-header {
            padding: 10px 14px;
          }
          .tank-mix-title {
            font-size: 1rem;
          }
          .tank-mix-close-x {
            width: 28px;
            height: 28px;
            font-size: 1rem;
          }
          .tank-mix-content {
            padding: 8px;
          }
          .tank-mix-table th, .tank-mix-table td {
            padding: 6px 8px;
            font-size: 0.72rem;
          }
          .tank-mix-instructions {
            min-width: 150px;
            font-size: 0.7rem;
          }
          .tank-mix-footer {
            padding: 10px 14px;
          }
          .tank-mix-close-btn {
            padding: 8px 18px;
            font-size: 0.8rem;
          }
        }
      `}</style>

      <div className="tank-mix-modal" onClick={handleModalClick}>
        <div className="tank-mix-header">
          <h2 className="tank-mix-title">
            🧪 Tank Mix Recipes
          </h2>
          <button
            type="button"
            onClick={requestClose}
            className="tank-mix-close-x"
            title="Close"
          >
            ✕
          </button>
        </div>

        <div className="tank-mix-content">
          <div className="tank-mix-table-wrapper">
            <table className="tank-mix-table">
              <thead>
                <tr>
                  <th className="header-standard">Herbicide</th>
                  <th className="header-yellow">Full Tank 400L</th>
                  <th className="header-green">½ Tank 200L</th>
                  <th className="header-pink">¼ Tank 100L</th>
                  <th className="header-standard">Surfactant</th>
                  <th className="header-standard">Instructions</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="tank-mix-herbicide-name">Transorb HC</td>
                  <td className="tank-mix-value">5L</td>
                  <td className="tank-mix-value">2.5</td>
                  <td className="tank-mix-value">1.25</td>
                  <td></td>
                  <td className="tank-mix-instructions"></td>
                </tr>
                <tr>
                  <td className="tank-mix-herbicide-name">Tordon 22K</td>
                  <td className="tank-mix-value">¾ L</td>
                  <td className="tank-mix-value">½ L</td>
                  <td className="tank-mix-value">¼ L</td>
                  <td></td>
                  <td className="tank-mix-instructions"></td>
                </tr>
                <tr>
                  <td className="tank-mix-herbicide-name">MCPA</td>
                  <td className="tank-mix-value">¾ L</td>
                  <td className="tank-mix-value">½ L</td>
                  <td className="tank-mix-value">¼ L</td>
                  <td></td>
                  <td className="tank-mix-instructions">Add once tank is half full &amp; AFTER Transorb</td>
                </tr>
                <tr>
                  <td className="tank-mix-herbicide-name">Escort/Assure</td>
                  <td className="tank-mix-value">16g</td>
                  <td className="tank-mix-value">8g</td>
                  <td className="tank-mix-value">4g</td>
                  <td className="tank-mix-surfactant-yes">YES</td>
                  <td className="tank-mix-instructions">16g in 10L water, ½ jug per SXS tank + surfactant</td>
                </tr>
                <tr>
                  <td className="tank-mix-herbicide-name">Par III</td>
                  <td className="tank-mix-value">5L</td>
                  <td className="tank-mix-value">2.5L</td>
                  <td className="tank-mix-value">1.25L</td>
                  <td></td>
                  <td className="tank-mix-instructions"></td>
                </tr>
                <tr>
                  <td className="tank-mix-herbicide-name">Garlon</td>
                  <td className="tank-mix-value">7L</td>
                  <td className="tank-mix-value">3.5L</td>
                  <td className="tank-mix-value">1.75L</td>
                  <td className="tank-mix-surfactant-yes">YES</td>
                  <td className="tank-mix-instructions"></td>
                </tr>
                <tr>
                  <td className="tank-mix-herbicide-name">Draft</td>
                  <td className="tank-mix-value">8g</td>
                  <td className="tank-mix-value">4g</td>
                  <td className="tank-mix-value">2g</td>
                  <td className="tank-mix-surfactant-yes">YES</td>
                  <td className="tank-mix-instructions">8g in 10L water, ⅓ jug per SXS tank + surfactant</td>
                </tr>
                <tr>
                  <td className="tank-mix-herbicide-name">Tracker XP</td>
                  <td className="tank-mix-value">2.5L</td>
                  <td className="tank-mix-value">1.25L</td>
                  <td className="tank-mix-value">0.65L</td>
                  <td></td>
                  <td className="tank-mix-instructions"></td>
                </tr>
                <tr>
                  <td className="tank-mix-herbicide-name">Trillion</td>
                  <td className="tank-mix-value">10L</td>
                  <td className="tank-mix-value">5L</td>
                  <td className="tank-mix-value">2.5L</td>
                  <td></td>
                  <td className="tank-mix-instructions"></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="tank-mix-footer">
          <button
            type="button"
            onClick={requestClose}
            className="tank-mix-close-btn"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
