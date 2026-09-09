import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide34() {
  return (
    <Frame number={34} section="Product Tour">
      <SectionTitle eyebrow="TRUST" title="Trust: Data Health" subtitle="Reconciliation and sync status." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Live sync timestamps</Bullet>
          <Bullet>Reconciliation status across systems</Bullet>
          <Bullet>Visibility into unmapped records</Bullet>
          <Bullet>Builds confidence in dashboard figures</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col justify-center gap-[3vh]">
          <div className="flex items-center gap-[2vw] p-[1.5vw] border border-[#4ccfa3]/30 bg-[#4ccfa3]/10 rounded-[1vw]">
            <div className="w-[4vw] h-[4vw] rounded-full bg-[#4ccfa3]/20 flex items-center justify-center text-[#4ccfa3]">
              ✓
            </div>
            <div>
              <div className="text-[1.5vw] text-[#f5f2ea]">Primary Source Synced</div>
              <div className="text-[1.5vw] text-[#a9b7c2]">Last updated: XX mins ago</div>
            </div>
          </div>
          <div className="flex items-center gap-[2vw] p-[1.5vw] border border-[#f3b44b]/30 bg-[#f3b44b]/10 rounded-[1vw]">
            <div className="w-[4vw] h-[4vw] rounded-full bg-[#f3b44b]/20 flex items-center justify-center text-[#f3b44b]">
              !
            </div>
            <div>
              <div className="text-[1.5vw] text-[#f5f2ea]">Secondary Sync Delayed</div>
              <div className="text-[1.5vw] text-[#a9b7c2]">Last updated: X hours ago</div>
            </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}
