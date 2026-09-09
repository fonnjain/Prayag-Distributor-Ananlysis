import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide45() {
  return (
    <Frame number={45} section="Product Tour">
      <SectionTitle eyebrow="SALES" title="Sales: SKU Deep Dive" subtitle="Product-level performance analysis." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Item-level volume and revenue</Bullet>
          <Bullet>Distribution width and depth</Bullet>
          <Bullet>Margin realization per SKU</Bullet>
          <Bullet>Geographic penetration of items</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col">
           <div className="flex items-center gap-[2vw] mb-[2vh]">
             <div className="w-[5vw] h-[5vw] bg-[#1389e8]/10 border border-[#1389e8]/30 rounded-[1vw] flex items-center justify-center text-[#1389e8] text-[2vw]">P</div>
             <div>
               <div className="text-[1.5vw] text-[#f5f2ea]">Premium Widget X</div>
               <div className="text-[1.5vw] text-[#a9b7c2]">SKU: PRM-WID-XXXX</div>
             </div>
           </div>
           <div className="flex-1 flex gap-[2vw]">
             <div className="flex-1 border border-[#a9b7c2]/20 rounded p-[1vw] flex flex-col justify-center items-center">
               <div className="text-[2vw] text-[#f5f2ea]">XX,XXX</div>
               <div className="text-[1.5vw] text-[#a9b7c2]">Units Sold</div>
             </div>
             <div className="flex-1 border border-[#a9b7c2]/20 rounded p-[1vw] flex flex-col justify-center items-center">
               <div className="text-[2vw] text-[#4ccfa3]">XX%</div>
               <div className="text-[1.5vw] text-[#a9b7c2]">Store Penetration</div>
             </div>
             <div className="flex-1 border border-[#a9b7c2]/20 rounded p-[1vw] flex flex-col justify-center items-center">
               <div className="text-[2vw] text-[#f3b44b]">₹ XXX</div>
               <div className="text-[1.5vw] text-[#a9b7c2]">Avg Realization</div>
             </div>
           </div>
        </div>
      </div>
    </Frame>
  );
}
