import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide38() {
  return (
    <Frame number={38} section="Product Tour">
      <SectionTitle eyebrow="SALES" title="Sales: State Head" subtitle="State-level territory management." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Consolidated view for State Managers</Bullet>
          <Bullet>District-by-district performance</Bullet>
          <Bullet>Team hierarchy rollup</Bullet>
          <Bullet>Local target tracking</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col relative overflow-hidden">
           <div className="flex justify-between items-end border-b border-[#a9b7c2]/20 pb-[1vh] mb-[2vh]">
             <div className="text-[1.5vw] text-[#f5f2ea]">Karnataka</div>
             <div className="text-[1.5vw] text-[#a9b7c2]">XX Districts • X ASMs</div>
           </div>
           <div className="flex-1 flex gap-[1.5vw]">
             <div className="flex-[2] bg-[#a9b7c2]/10 rounded flex flex-col gap-[1vh] p-[1vw]">
                 <div className="flex justify-between items-center">
                   <div className="h-[1.5vh] w-[40%] bg-[#a9b7c2]/20 rounded" />
                   <div className="h-[1.5vh] w-[20%] bg-[#1389e8]/30 rounded" />
                 </div>
                 <div className="flex justify-between items-center">
                   <div className="h-[1.5vh] w-[40%] bg-[#a9b7c2]/20 rounded" />
                   <div className="h-[1.5vh] w-[20%] bg-[#1389e8]/30 rounded" />
                 </div>
                 <div className="flex justify-between items-center">
                   <div className="h-[1.5vh] w-[40%] bg-[#a9b7c2]/20 rounded" />
                   <div className="h-[1.5vh] w-[20%] bg-[#1389e8]/30 rounded" />
                 </div>
                 <div className="flex justify-between items-center">
                   <div className="h-[1.5vh] w-[40%] bg-[#a9b7c2]/20 rounded" />
                   <div className="h-[1.5vh] w-[20%] bg-[#1389e8]/30 rounded" />
                 </div>
             </div>
             <div className="flex-[1] bg-[#08121f]/50 border border-[#a9b7c2]/20 rounded p-[1vw] flex flex-col justify-center gap-[1vh]">
               <div className="h-[2vh] w-[80%] bg-[#4ccfa3]/30 rounded mx-auto" />
               <div className="text-center text-[1.5vw] text-[#a9b7c2]">Target Achieved</div>
             </div>
           </div>
        </div>
      </div>
    </Frame>
  );
}
