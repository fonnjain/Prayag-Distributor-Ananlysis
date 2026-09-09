import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide46() {
  return (
    <Frame number={46} section="Product Tour">
      <SectionTitle eyebrow="COMMERCIAL" title="Commercial: MRP Master" subtitle="Centralised pricing register." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Single source of truth for pricing</Bullet>
          <Bullet>Historical price change tracking</Bullet>
          <Bullet>State-wise tax structures</Bullet>
          <Bullet>Base price vs landed cost</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col gap-[1.5vh]">
           <div className="flex border-b border-[#a9b7c2]/30 pb-[1vh] mb-[1vh] text-[1.5vw] text-[#a9b7c2]">
             <div className="flex-[2]">SKU Name</div>
             <div className="flex-1">Base Price</div>
             <div className="flex-1">Tax</div>
             <div className="flex-1">MRP</div>
           </div>
             <div className="flex items-center py-[1vh] border-b border-[#a9b7c2]/10">
               <div className="flex-[2] h-[1.5vh] bg-[#a9b7c2]/20 rounded mr-[2vw]" />
               <div className="flex-1 text-[1.5vw] text-[#a9b7c2]">₹ XXX</div>
               <div className="flex-1 text-[1.5vw] text-[#a9b7c2]">XX%</div>
               <div className="flex-1 text-[1.5vw] text-[#f5f2ea] font-medium">₹ XXX</div>
             </div>
             <div className="flex items-center py-[1vh] border-b border-[#a9b7c2]/10">
               <div className="flex-[2] h-[1.5vh] bg-[#a9b7c2]/20 rounded mr-[2vw]" />
               <div className="flex-1 text-[1.5vw] text-[#a9b7c2]">₹ XXX</div>
               <div className="flex-1 text-[1.5vw] text-[#a9b7c2]">XX%</div>
               <div className="flex-1 text-[1.5vw] text-[#f5f2ea] font-medium">₹ XXX</div>
             </div>
             <div className="flex items-center py-[1vh] border-b border-[#a9b7c2]/10">
               <div className="flex-[2] h-[1.5vh] bg-[#a9b7c2]/20 rounded mr-[2vw]" />
               <div className="flex-1 text-[1.5vw] text-[#a9b7c2]">₹ XXX</div>
               <div className="flex-1 text-[1.5vw] text-[#a9b7c2]">XX%</div>
               <div className="flex-1 text-[1.5vw] text-[#f5f2ea] font-medium">₹ XXX</div>
             </div>
             <div className="flex items-center py-[1vh] border-b border-[#a9b7c2]/10">
               <div className="flex-[2] h-[1.5vh] bg-[#a9b7c2]/20 rounded mr-[2vw]" />
               <div className="flex-1 text-[1.5vw] text-[#a9b7c2]">₹ XXX</div>
               <div className="flex-1 text-[1.5vw] text-[#a9b7c2]">XX%</div>
               <div className="flex-1 text-[1.5vw] text-[#f5f2ea] font-medium">₹ XXX</div>
             </div>
        </div>
      </div>
    </Frame>
  );
}
