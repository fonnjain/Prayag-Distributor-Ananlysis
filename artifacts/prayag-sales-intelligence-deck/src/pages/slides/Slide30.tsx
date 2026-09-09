import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide30() {
  return (
    <Frame number={30} section="Product Tour">
      <SectionTitle eyebrow="REPORTING" title="Reporting: Company Reports" subtitle="Enterprise-wide consolidated views." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Aggregated national figures</Bullet>
          <Bullet>Cross-division performance roll-ups</Bullet>
          <Bullet>C-level summary perspectives</Bullet>
          <Bullet>Standardized format for board review</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col items-center justify-center relative">
           <div className="w-full flex justify-center mb-[2vh]">
             <div className="w-[40%] h-[6vh] bg-[#1389e8]/30 border border-[#1389e8]/50 rounded flex items-center justify-center text-[1.5vw] text-[#e4ebef]">National Roll-up</div>
           </div>
           <div className="w-[2px] h-[3vh] bg-[#a9b7c2]/30" />
           <div className="w-[60%] h-[2px] bg-[#a9b7c2]/30" />
           <div className="w-[60%] flex justify-between">
             <div className="w-[2px] h-[3vh] bg-[#a9b7c2]/30" />
             <div className="w-[2px] h-[3vh] bg-[#a9b7c2]/30" />
           </div>
           <div className="w-[80%] flex justify-between">
             <div className="w-[45%] h-[5vh] bg-[#a9b7c2]/10 rounded" />
             <div className="w-[45%] h-[5vh] bg-[#a9b7c2]/10 rounded" />
           </div>
        </div>
      </div>
    </Frame>
  );
}
