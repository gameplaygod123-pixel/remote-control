// Phase B verification: feed the PATCHED RtcpReceivingSession a run of in-order RTP
// packets then one past a gap, and confirm it emits a Generic NACK (RTPFB PT=205
// FMT=1) listing exactly the missing sequence numbers. Proves the NACK-emit patch
// works, on the Mac, without needing a lossy live link.
#include "rtc/rtcpreceivingsession.hpp"
#include "rtc/rtp.hpp"
#include "rtc/message.hpp"
#include <cstdio>
#include <cstdint>
#include <memory>
#include <vector>
using namespace rtc;

static message_ptr makeRtp(uint16_t seq) {
	auto msg = std::make_shared<Message>(sizeof(RtpHeader) + 8, Message::Binary);
	auto *h = reinterpret_cast<RtpHeader *>(msg->data());
	h->preparePacket();       // sets RTP version 2
	h->setPayloadType(96);
	h->setSeqNumber(seq);
	h->setSsrc(0x1234abcd);
	h->setTimestamp(1000);
	return msg;
}

int main() {
	RtcpReceivingSession rrs;
	int nackCount = 0;
	std::vector<uint16_t> nacked;
	message_callback send = [&](message_ptr m) {
		if (m->type != Message::Control || m->size() < 12)
			return;
		auto *b = reinterpret_cast<const uint8_t *>(m->data());
		uint8_t fmt = b[0] & 0x1f;
		uint8_t pt = b[1];
		if (pt == 205 && fmt == 1) { // RTPFB Generic NACK
			nackCount++;
			auto *nack = reinterpret_cast<RtcpNack *>(m->data());
			unsigned int n = nack->getSeqNoCount();
			for (unsigned int i = 0; i < n; i++)
				for (uint16_t s : nack->parts[i].getSequenceNumbers())
					nacked.push_back(s);
		}
	};

	// establish a valid source with 3 in-order packets
	for (uint16_t s = 1000; s <= 1002; s++) {
		message_vector v{makeRtp(s)};
		rrs.incoming(v, send);
	}
	// gap: 1003 + 1004 missing, deliver 1005
	{
		message_vector v{makeRtp(1005)};
		rrs.incoming(v, send);
	}

	printf("NACK packets emitted: %d\n", nackCount);
	printf("NACKed seqs:");
	for (auto s : nacked) printf(" %u", s);
	printf("\n");

	bool ok = nackCount == 1 && nacked.size() == 2 && nacked[0] == 1003 && nacked[1] == 1004;
	printf("RESULT: %s\n", ok ? "PASS - patched RtcpReceivingSession emits NACK on a gap"
	                          : "FAIL");
	return ok ? 0 : 1;
}
