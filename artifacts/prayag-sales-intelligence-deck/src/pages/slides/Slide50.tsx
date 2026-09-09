import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide50() {
  return (
    <Frame number={50} section="Product Tour">
      <SectionTitle eyebrow="CUSTOMERS" title="Customers: Rankings" subtitle="Top performing accounts." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Volume and revenue leaderboards</Bullet>
          <Bullet>Growth rate ranking</Bullet>
          <Bullet>Loyalty and consistency scoring</Bullet>
          <Bullet>Reward program qualification</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col gap-[1.5vh]">
           <div className="flex items-center gap-[1vw] bg-[#1389e8]/10 border border-[#1389e8]/30 p-[1vw] rounded">
             <div className="text-[2vw] text-[#1389e8] font-bold w-[3vw]">1</div>
             <div className="flex-1">
               <div className="text-[1.5vw] text-[#f5f2ea]">Premier Retail Group</div>
               <div className="text-[1.5vw] text-[#a9b7c2]">₹ X.X Cr YTD</div>
             </div>
           </div>
           <div className="flex items-center gap-[1vw] bg-[#a9b7c2]/5 border border-[#a9b7c2]/10 p-[1vw] rounded">
             <div className="text-[2vw] text-[#a9b7c2] font-bold w-[3vw]">2</div>
             <div className="flex-1">
               <div className="text-[1.5vw] text-[#f5f2ea]">Metro Superstore</div>
               <div className="text-[1.5vw] text-[#a9b7c2]">₹ X.X Cr YTD</div>
             </div>
           </div>
           <div className="flex items-center gap-[1vw] bg-[#a9b7c2]/5 border border-[#a9b7c2]/10 p-[1vw] rounded">
             <div className="text-[2vw] text-[#a9b7c2] font-bold w-[3vw]">3</div>
             <div className="flex-1">
               <div className="text-[1.5vw] text-[#f5f2ea]">City Mart</div>
               <div className="text-[1.5vw] text-[#a9b7c2]">₹ X.X Cr YTD</div>
             </div>
           </div>
        </div>
      </div>
    </Frame>
  );
}
