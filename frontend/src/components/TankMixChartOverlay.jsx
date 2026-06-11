import React from 'react';

export default function TankMixChartOverlay({ onClose }) {
  // Prevent clicks inside the modal from bubbling up to the backdrop
  const handleModalClick = (e) => e.stopPropagation();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      style={{ backgroundColor: 'rgba(15, 23, 42, 0.75)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="bg-slate-900 rounded-xl shadow-2xl border border-slate-700 max-w-4xl w-full max-h-full overflow-hidden flex flex-col animate-in fade-in zoom-in duration-200"
        onClick={handleModalClick}
      >
        <div className="flex items-center justify-between p-4 border-b border-slate-700 bg-slate-800/50">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            🧪 Tank Recipes
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white hover:bg-slate-700/50 rounded-lg p-2 transition-colors"
            title="Close"
          >
            ✕
          </button>
        </div>

        <div className="p-4 sm:p-6 overflow-auto">
          <div className="overflow-x-auto rounded-lg border border-slate-700">
            <table className="w-full text-left border-collapse text-sm sm:text-base">
              <thead>
                <tr>
                  <th className="bg-slate-800 text-white font-semibold p-3 border-b border-slate-700">Herbicide</th>
                  <th className="bg-yellow-400 text-slate-900 font-bold p-3 border-b border-slate-700 whitespace-nowrap">Full Tank 400L</th>
                  <th className="bg-green-400 text-slate-900 font-bold p-3 border-b border-slate-700 whitespace-nowrap">½ Tank 200L</th>
                  <th className="bg-fuchsia-400 text-slate-900 font-bold p-3 border-b border-slate-700 whitespace-nowrap">¼ Tank 100L</th>
                  <th className="bg-slate-800 text-white font-semibold p-3 border-b border-slate-700">Surfactant</th>
                  <th className="bg-slate-800 text-white font-semibold p-3 border-b border-slate-700 min-w-[200px]">Instructions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                <tr className="hover:bg-slate-800/50 transition-colors">
                  <td className="p-3 text-white">Transorb HC</td>
                  <td className="p-3 text-slate-300 font-medium">5L</td>
                  <td className="p-3 text-slate-300 font-medium">2.5</td>
                  <td className="p-3 text-slate-300 font-medium">1.25</td>
                  <td className="p-3 text-slate-400"></td>
                  <td className="p-3 text-slate-400"></td>
                </tr>
                <tr className="hover:bg-slate-800/50 transition-colors">
                  <td className="p-3 text-white">Tordon 22K</td>
                  <td className="p-3 text-slate-300 font-medium">¾ L</td>
                  <td className="p-3 text-slate-300 font-medium">½ L</td>
                  <td className="p-3 text-slate-300 font-medium">¼ L</td>
                  <td className="p-3 text-slate-400"></td>
                  <td className="p-3 text-slate-400"></td>
                </tr>
                <tr className="hover:bg-slate-800/50 transition-colors">
                  <td className="p-3 text-white">MCPA</td>
                  <td className="p-3 text-slate-300 font-medium">¾ L</td>
                  <td className="p-3 text-slate-300 font-medium">½ L</td>
                  <td className="p-3 text-slate-300 font-medium">¼ L</td>
                  <td className="p-3 text-slate-400"></td>
                  <td className="p-3 text-slate-300">Add once tank is full &amp; AFTER Transorb</td>
                </tr>
                <tr className="hover:bg-slate-800/50 transition-colors">
                  <td className="p-3 text-white">Escort/Assure</td>
                  <td className="p-3 text-slate-300 font-medium">16g</td>
                  <td className="p-3 text-slate-300 font-medium">8g</td>
                  <td className="p-3 text-slate-300 font-medium">4g</td>
                  <td className="p-3 text-emerald-400 font-semibold">YES</td>
                  <td className="p-3 text-slate-300">16g in 10L water, ½ jug per SXS tank + surfactant</td>
                </tr>
                <tr className="hover:bg-slate-800/50 transition-colors">
                  <td className="p-3 text-white">Par III</td>
                  <td className="p-3 text-slate-300 font-medium">5L</td>
                  <td className="p-3 text-slate-300 font-medium">2.5L</td>
                  <td className="p-3 text-slate-300 font-medium">1.25L</td>
                  <td className="p-3 text-slate-400"></td>
                  <td className="p-3 text-slate-400"></td>
                </tr>
                <tr className="hover:bg-slate-800/50 transition-colors">
                  <td className="p-3 text-white">Garlon</td>
                  <td className="p-3 text-slate-300 font-medium">7L</td>
                  <td className="p-3 text-slate-300 font-medium">3.5L</td>
                  <td className="p-3 text-slate-300 font-medium">1.75L</td>
                  <td className="p-3 text-emerald-400 font-semibold">YES</td>
                  <td className="p-3 text-slate-400"></td>
                </tr>
                <tr className="hover:bg-slate-800/50 transition-colors">
                  <td className="p-3 text-white">Draft</td>
                  <td className="p-3 text-slate-300 font-medium">8g</td>
                  <td className="p-3 text-slate-300 font-medium">4g</td>
                  <td className="p-3 text-slate-300 font-medium">2g</td>
                  <td className="p-3 text-emerald-400 font-semibold">YES</td>
                  <td className="p-3 text-slate-300">8g in 10L water, ⅓ jug per SXS tank + surfactant</td>
                </tr>
                <tr className="hover:bg-slate-800/50 transition-colors">
                  <td className="p-3 text-white">Tracker XP</td>
                  <td className="p-3 text-slate-300 font-medium">2.5L</td>
                  <td className="p-3 text-slate-300 font-medium">1.25L</td>
                  <td className="p-3 text-slate-300 font-medium">0.65L</td>
                  <td className="p-3 text-slate-400"></td>
                  <td className="p-3 text-slate-400"></td>
                </tr>
                <tr className="hover:bg-slate-800/50 transition-colors">
                  <td className="p-3 text-white">Trillion</td>
                  <td className="p-3 text-slate-300 font-medium">10L</td>
                  <td className="p-3 text-slate-300 font-medium">5L</td>
                  <td className="p-3 text-slate-300 font-medium">2.5L</td>
                  <td className="p-3 text-slate-400"></td>
                  <td className="p-3 text-slate-400"></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        
        <div className="p-4 border-t border-slate-700 bg-slate-800/50 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
