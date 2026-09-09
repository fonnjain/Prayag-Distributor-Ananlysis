import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide59() {
  return (
    <Frame number={59} section="Product Tour">
      <SectionTitle eyebrow="SYSTEM" title="Exports & Glossary" subtitle="Data portability and definitions." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>One-click CSV/Excel downloads</Bullet>
          <Bullet>Maintains applied filters in export</Bullet>
          <Bullet>Shared business glossary</Bullet>
          <Bullet>No vendor lock-in for raw data</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col items-center justify-center gap-[2vh]">
           <div className="w-[8vw] h-[8vw] rounded-full bg-[#1389e8]/20 flex items-center justify-center text-[3vw] text-[#1389e8]">
             ↓
           </div>
           <div className="text-[1.5vw] text-[#f5f2ea]">Export Complete</div>
           <div className="text-[1.5vw] text-[#a9b7c2]">XX,XXX rows downloaded as .csv</div>
        </div>
      </div>
    </Frame>
  );
}
