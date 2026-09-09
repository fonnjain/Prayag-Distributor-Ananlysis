import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide54() {
  return (
    <Frame number={54} section="Product Tour">
      <SectionTitle eyebrow="ORGANISATION" title="Organisation: Customers" subtitle="Master customer record management." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Golden record for all entities</Bullet>
          <Bullet>Hierarchical customer grouping</Bullet>
          <Bullet>Geography and attribute tagging</Bullet>
          <Bullet>Prevents data duplication</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex items-center justify-center">
          <div className="w-full max-w-[30vw] border border-[#a9b7c2]/20 rounded p-[1.5vw] bg-[#08121f]/50">
            <div className="h-[2vh] w-[40%] bg-[#1389e8]/50 rounded mb-[2vh]" />
            <div className="flex justify-between items-center border-b border-[#a9b7c2]/10 py-[1vh]">
              <span className="text-[1.5vw] text-[#a9b7c2]">Entity ID</span>
              <span className="text-[1.5vw] text-[#e4ebef]">CUST-XXXX</span>
            </div>
            <div className="flex justify-between items-center border-b border-[#a9b7c2]/10 py-[1vh]">
              <span className="text-[1.5vw] text-[#a9b7c2]">GSTIN</span>
              <span className="text-[1.5vw] text-[#e4ebef]">Verified</span>
            </div>
            <div className="flex justify-between items-center py-[1vh]">
              <span className="text-[1.5vw] text-[#a9b7c2]">Type</span>
              <span className="text-[1.5vw] text-[#e4ebef]">Distributor</span>
            </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}
